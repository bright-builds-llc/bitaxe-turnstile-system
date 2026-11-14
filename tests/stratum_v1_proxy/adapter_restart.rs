//! An adapter restart that keeps its outbox credits nothing twice (Ticket 27).
//!
//! Under ADR-0109 the Pool Adapter runs inside `gate-authority`, so a restart
//! stops the proxy, delivery and the Authority together and starts them again on
//! the same database.

use std::{
    error::Error,
    net::SocketAddr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use bwg_core::{
    authority::{AuthorityApplication, SimulatedPoolAdapter},
    challenge::ChallengeId,
    pool_offer::PoolSelection,
    progress::{AcceptedWorkEvent, WorkSessionId},
    stratum_v1::{
        AcceptedWorkSink, AcceptedWorkSinkError, PostgresStratumSessionRegistry,
        StratumCredentialIssuer, StratumLeaseContext, StratumSessionCredentials,
        WorkSessionDisconnectSink, WorkSessionDisconnectSinkError,
        in_process::{InProcessPoolAdapterConfig, spawn_in_process_pool_adapter},
    },
};
use serde_json::Value;
use sqlx::PgPool;
use tokio::{
    io::{AsyncBufReadExt as _, BufReader, Lines},
    net::{
        TcpListener, TcpStream,
        tcp::{OwnedReadHalf, OwnedWriteHalf},
    },
    sync::Notify,
    task::JoinSet,
};

use super::{
    PostgresTestDatabase,
    authority_delivery::{LeasedAuthority, authority_config, leased_authority},
    fixtures::{StratumJobFields, hex_target, worked_nonce, write_line},
};

/// `in_process::DELIVERY_LEASE_SECONDS`: how long a claim outlives its process.
const DELIVERY_LEASE_SECONDS: i64 = 30;
const WAIT_TIMEOUT: Duration = Duration::from_secs(10);
const WAIT_POLL: Duration = Duration::from_millis(20);
/// Several of `in_process::DELIVERY_INTERVAL`, so a replay would have been delivered.
const QUIET_PERIOD: Duration = Duration::from_secs(1);
const SESSION: &str = "session_adapter_restart_01";
const PAYOUT_ADDRESS: &str = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
const EXTRANONCE1: &str = "01020304";
const JOB_ID: &str = "job-restart-01";
const PREVIOUS_BLOCK_HASH: &str =
    "0000000000000000000000000000000000000000000000000000000000000000";
const COINBASE1: &str = "01000000";
const COINBASE2: &str = "00";
const VERSION: &str = "20000000";
const NETWORK_BITS: &str = "1d00ffff";
const NTIME: &str = "5f5e1000";
/// The share target of `mining.set_difficulty` 0.000000001.
const SHARE_TARGET: &str = "3b9a8e6536000000000000000000000000000000000000000000000000000000";

#[tokio::test]
async fn restarted_adapter_credits_its_reclaimed_event_once_and_never_replays_acknowledged_work()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let pool = PgPool::connect(database.database_url()).await?;
    let leased = leased_authority(
        &database,
        "action_adapter_restart_01",
        SESSION,
        "boot_adapter_restart_01",
    )
    .await?;
    let credentials = register_worker(&database, &leased).await?;
    let pool_address = spawn_mining_pool().await?;
    let first_port = RecordingPort::new(leased.adapter.clone());
    let first_process = start_adapter(&database, pool_address, first_port.clone()).await?;
    let mut worker = Worker::connect(first_process.proxy_address, &credentials).await?;
    worker.submit(3, "00000001").await?;
    first_port.wait_for_deliveries(1).await?;
    let acknowledged = only_outbox_event(&pool).await?;
    wait_for_outbox_state(&pool, &acknowledged, "acknowledged").await?;
    first_port.stop_after_next_credit();
    worker.submit(4, "00000002").await?;
    let credited_before_stop = first_port.wait_until_stopped().await?;
    drop(first_process);
    let reclaimable = expire_unacknowledged_claim(&pool).await?;

    // Act
    let restarted_application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let restarted_port = RecordingPort::new(restarted_application.simulated_pool_adapter());
    let _restarted_process = start_adapter(&database, pool_address, restarted_port.clone()).await?;
    wait_until_nothing_pending(&pool).await?;
    tokio::time::sleep(QUIET_PERIOD).await;

    // Assert
    assert_eq!(restarted_port.deliveries()?, vec![credited_before_stop]);
    assert_eq!(
        outbox_state(&pool, &reclaimable).await?,
        ("acknowledged".to_owned(), 2)
    );
    let mut expected_events = vec![
        (acknowledged.clone(), "credited"),
        (reclaimable.clone(), "credited"),
    ];
    expected_events.sort();
    let recorded = recorded_events(&pool).await?;
    assert_eq!(
        recorded
            .iter()
            .map(|event| (event.event_id.clone(), event.disposition.as_str()))
            .collect::<Vec<_>>(),
        expected_events
    );
    let credited_total: u128 = recorded.iter().map(|event| event.credited_work).sum();
    assert_eq!(
        verified_progress(&pool, &leased.challenge_id).await?,
        credited_total
    );
    drop(worker);
    Ok(())
}

/// The in-process port, recording each event the Authority took.
///
/// Once told to, it stops for good right after the Authority credits the next
/// event, as a process that dies before the outbox records the acknowledgement.
#[derive(Clone)]
struct RecordingPort {
    adapter: SimulatedPoolAdapter,
    delivered: Arc<Mutex<Vec<AcceptedWorkEvent>>>,
    stop_after_credit: Arc<AtomicBool>,
    stopped: Arc<Notify>,
}

impl RecordingPort {
    fn new(adapter: SimulatedPoolAdapter) -> Self {
        Self {
            adapter,
            delivered: Arc::new(Mutex::new(Vec::new())),
            stop_after_credit: Arc::new(AtomicBool::new(false)),
            stopped: Arc::new(Notify::new()),
        }
    }

    fn deliveries(&self) -> Result<Vec<AcceptedWorkEvent>, Box<dyn Error>> {
        Ok(self
            .delivered
            .lock()
            .map_err(|_| "recording port lock is poisoned")?
            .clone())
    }

    fn stop_after_next_credit(&self) {
        self.stop_after_credit.store(true, Ordering::SeqCst);
    }

    async fn wait_for_deliveries(
        &self,
        count: usize,
    ) -> Result<Vec<AcceptedWorkEvent>, Box<dyn Error>> {
        let deadline = tokio::time::Instant::now() + WAIT_TIMEOUT;
        loop {
            let deliveries = self.deliveries()?;
            if deliveries.len() >= count {
                return Ok(deliveries);
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(format!("{count} deliveries never reached the Authority").into());
            }
            tokio::time::sleep(WAIT_POLL).await;
        }
    }

    /// The event the Authority credited before delivery stopped.
    async fn wait_until_stopped(&self) -> Result<AcceptedWorkEvent, Box<dyn Error>> {
        tokio::time::timeout(WAIT_TIMEOUT, self.stopped.notified())
            .await
            .map_err(|_| "delivery never stopped after a credit")?;
        self.deliveries()?
            .pop()
            .ok_or_else(|| "a stopped delivery must have reached the Authority".into())
    }
}

#[async_trait]
impl AcceptedWorkSink for RecordingPort {
    async fn deliver(
        &self,
        event: AcceptedWorkEvent,
        lease_context: StratumLeaseContext,
    ) -> Result<(), AcceptedWorkSinkError> {
        AcceptedWorkSink::deliver(&self.adapter, event.clone(), lease_context).await?;
        self.delivered
            .lock()
            .map_err(|_| AcceptedWorkSinkError::Unavailable)?
            .push(event);
        if self.stop_after_credit.load(Ordering::SeqCst) {
            self.stopped.notify_one();
            std::future::pending::<()>().await;
        }
        Ok(())
    }
}

#[async_trait]
impl WorkSessionDisconnectSink for RecordingPort {
    async fn disconnected(
        &self,
        session_id: &WorkSessionId,
    ) -> Result<(), WorkSessionDisconnectSinkError> {
        self.adapter.disconnected(session_id).await
    }
}

/// The adapter's tasks; dropping them stops the proxy, delivery and the sweep.
struct AdapterProcess {
    _tasks: JoinSet<()>,
    proxy_address: SocketAddr,
}

async fn start_adapter(
    database: &PostgresTestDatabase,
    pool_address: SocketAddr,
    port: RecordingPort,
) -> Result<AdapterProcess, Box<dyn Error>> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let proxy_address = listener.local_addr()?;
    let config = InProcessPoolAdapterConfig {
        database_url: database.database_url().to_owned(),
        upstream_address: pool_address.to_string(),
        upstream_password: "x".to_owned(),
    };
    let tasks = spawn_in_process_pool_adapter(config, listener, port).await?;
    Ok(AdapterProcess {
        _tasks: tasks,
        proxy_address,
    })
}

/// Issues the Worker's Stratum credentials and stores the claimant's Pool Selection.
async fn register_worker(
    database: &PostgresTestDatabase,
    leased: &LeasedAuthority,
) -> Result<StratumSessionCredentials, Box<dyn Error>> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let registry = PostgresStratumSessionRegistry::connect(database.database_url()).await?;
    let credentials = StratumCredentialIssuer::new([27_u8; 32]).issue(
        leased.session_id.clone(),
        leased.lease_context.clone(),
        now,
        now + 60,
        now + 300,
    )?;
    registry.register(&credentials).await?;
    let selection = PoolSelection::bitcoin_address(
        "pool_offer_hydra_solo_v1".to_owned(),
        PAYOUT_ADDRESS.to_owned(),
    )?;
    registry
        .record_pool_selection(
            &leased.session_id,
            &leased.challenge_id,
            &selection,
            now + 300,
            now,
        )
        .await?;
    Ok(credentials)
}

/// A Mining Pool that sends one job and accepts every share.
async fn spawn_mining_pool() -> Result<SocketAddr, std::io::Error> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    tokio::spawn(async move {
        if let Err(error) = serve_mining_pool(listener).await {
            tracing::warn!(%error, "test Mining Pool stopped");
        }
    });
    Ok(address)
}

async fn serve_mining_pool(listener: TcpListener) -> Result<(), Box<dyn Error + Send + Sync>> {
    let (stream, _) = listener.accept().await?;
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    let subscribe = next_request_id(&mut lines).await?;
    write_line(
        &mut write,
        &format!(
            r#"{{"id":{subscribe},"result":[[["mining.notify","restart"]],"{EXTRANONCE1}",4],"error":null}}"#
        ),
    )
    .await?;
    let authorize = next_request_id(&mut lines).await?;
    write_line(
        &mut write,
        &format!(r#"{{"id":{authorize},"result":true,"error":null}}"#),
    )
    .await?;
    write_line(
        &mut write,
        r#"{"id":null,"method":"mining.set_difficulty","params":[0.000000001]}"#,
    )
    .await?;
    write_line(
        &mut write,
        &format!(
            r#"{{"id":null,"method":"mining.notify","params":["{JOB_ID}","{PREVIOUS_BLOCK_HASH}","{COINBASE1}","{COINBASE2}",[],"{VERSION}","{NETWORK_BITS}","{NTIME}",true]}}"#
        ),
    )
    .await?;
    loop {
        let submit = next_request_id(&mut lines).await?;
        write_line(
            &mut write,
            &format!(r#"{{"id":{submit},"result":true,"error":null}}"#),
        )
        .await?;
    }
}

async fn next_request_id(
    lines: &mut Lines<BufReader<OwnedReadHalf>>,
) -> Result<Value, Box<dyn Error + Send + Sync>> {
    let line = lines
        .next_line()
        .await?
        .ok_or("the proxy closed the Mining Pool connection")?;
    Ok(serde_json::from_str::<Value>(&line)?["id"].clone())
}

/// A Worker connected through the proxy with its session's credentials.
struct Worker {
    lines: Lines<BufReader<OwnedReadHalf>>,
    write: OwnedWriteHalf,
    username: String,
}

impl Worker {
    /// Subscribes, authorizes and reads the difficulty and job the pool sends.
    async fn connect(
        proxy_address: SocketAddr,
        credentials: &StratumSessionCredentials,
    ) -> Result<Self, Box<dyn Error>> {
        let (read, write) = TcpStream::connect(proxy_address).await?.into_split();
        let mut worker = Self {
            lines: BufReader::new(read).lines(),
            write,
            username: credentials.username().to_owned(),
        };
        worker
            .request(r#"{"id":1,"method":"mining.subscribe","params":[]}"#)
            .await?;
        let authorized = worker
            .request(&format!(
                r#"{{"id":2,"method":"mining.authorize","params":["{}","{}"]}}"#,
                credentials.username(),
                credentials.secret()
            ))
            .await?;
        if authorized != r#"{"id":2,"result":true,"error":null}"# {
            return Err(format!("the proxy refused the Worker: {authorized}").into());
        }
        worker.next_line().await?;
        worker.next_line().await?;
        Ok(worker)
    }

    /// Submits one distinct share and waits for the proxy to report it accepted.
    async fn submit(&mut self, request_id: u32, extranonce2: &str) -> Result<(), Box<dyn Error>> {
        let job = StratumJobFields::new(
            PREVIOUS_BLOCK_HASH,
            COINBASE1,
            COINBASE2,
            VERSION,
            NETWORK_BITS,
            NTIME,
        );
        let nonce = worked_nonce(EXTRANONCE1, extranonce2, job, hex_target(SHARE_TARGET)?)?;
        let username = &self.username;
        let accepted = self
            .request(&format!(
                r#"{{"id":{request_id},"method":"mining.submit","params":["{username}","{JOB_ID}","{extranonce2}","{NTIME}","{nonce}"]}}"#
            ))
            .await?;
        let expected = format!(r#"{{"id":{request_id},"result":true,"error":null}}"#);
        if accepted != expected {
            return Err(format!("the proxy did not accept share {request_id}: {accepted}").into());
        }
        Ok(())
    }

    async fn request(&mut self, line: &str) -> Result<String, Box<dyn Error>> {
        write_line(&mut self.write, line).await?;
        self.next_line().await
    }

    async fn next_line(&mut self) -> Result<String, Box<dyn Error>> {
        Ok(self
            .lines
            .next_line()
            .await?
            .ok_or("the proxy closed the Worker connection")?)
    }
}

/// The one event in the outbox so far.
async fn only_outbox_event(pool: &PgPool) -> Result<String, Box<dyn Error>> {
    let event_ids: Vec<String> =
        sqlx::query_scalar("SELECT event_id FROM pool_adapter.accepted_work_outbox")
            .fetch_all(pool)
            .await?;
    let [event_id] = event_ids.as_slice() else {
        return Err(format!("expected one outbox event, found {}", event_ids.len()).into());
    };
    Ok(event_id.clone())
}

/// Waits until the restarted adapter has settled every event it will deliver.
async fn wait_until_nothing_pending(pool: &PgPool) -> Result<(), Box<dyn Error>> {
    let deadline = tokio::time::Instant::now() + WAIT_TIMEOUT;
    loop {
        let pending: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pool_adapter.accepted_work_outbox
             WHERE delivery_state = 'pending'",
        )
        .fetch_one(pool)
        .await?;
        if pending == 0 {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!("{pending} outbox events were never settled").into());
        }
        tokio::time::sleep(WAIT_POLL).await;
    }
}

/// An outbox event's delivery state and how many times it was claimed.
async fn outbox_state(pool: &PgPool, event_id: &str) -> Result<(String, i32), Box<dyn Error>> {
    Ok(sqlx::query_as(
        "SELECT delivery_state, delivery_attempts FROM pool_adapter.accepted_work_outbox
         WHERE event_id = $1",
    )
    .bind(event_id)
    .fetch_one(pool)
    .await?)
}

async fn wait_for_outbox_state(
    pool: &PgPool,
    event_id: &str,
    state: &str,
) -> Result<(), Box<dyn Error>> {
    let deadline = tokio::time::Instant::now() + WAIT_TIMEOUT;
    loop {
        let current: String = sqlx::query_scalar(
            "SELECT delivery_state FROM pool_adapter.accepted_work_outbox WHERE event_id = $1",
        )
        .bind(event_id)
        .fetch_one(pool)
        .await?;
        if current == state {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!("outbox event stayed {current}, never {state}").into());
        }
        tokio::time::sleep(WAIT_POLL).await;
    }
}

/// Finds the one claim the stopped process left unacknowledged, then lets its
/// delivery lease run out, as it does while the process is down.
async fn expire_unacknowledged_claim(pool: &PgPool) -> Result<String, Box<dyn Error>> {
    let event_ids: Vec<String> = sqlx::query_scalar(
        "UPDATE pool_adapter.accepted_work_outbox
         SET delivery_lease_expires_at_unix_seconds =
             delivery_lease_expires_at_unix_seconds - $1
         WHERE delivery_state = 'pending' AND delivery_owner IS NOT NULL
         RETURNING event_id",
    )
    .bind(DELIVERY_LEASE_SECONDS)
    .fetch_all(pool)
    .await?;
    let [event_id] = event_ids.as_slice() else {
        return Err(format!(
            "the stopped process must leave one claim unacknowledged, found {}",
            event_ids.len()
        )
        .into());
    };
    Ok(event_id.clone())
}

/// One Accepted Work Event the Authority recorded.
struct RecordedEvent {
    event_id: String,
    disposition: String,
    credited_work: u128,
}

/// Every event the Authority recorded for the session, whatever its disposition.
async fn recorded_events(pool: &PgPool) -> Result<Vec<RecordedEvent>, Box<dyn Error>> {
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT event_id, disposition, credited_work::text
         FROM gate_authority.accepted_work_events
         WHERE session_id = $1
         ORDER BY event_id",
    )
    .bind(SESSION)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|(event_id, disposition, maybe_work)| {
            Ok(RecordedEvent {
                event_id,
                disposition,
                credited_work: maybe_work.as_deref().unwrap_or("0").parse()?,
            })
        })
        .collect()
}

async fn verified_progress(
    pool: &PgPool,
    challenge_id: &ChallengeId,
) -> Result<u128, Box<dyn Error>> {
    let progress: String = sqlx::query_scalar(
        "SELECT verified_progress::text FROM gate_authority.work_challenges
         WHERE challenge_id = $1",
    )
    .bind(challenge_id.as_str())
    .fetch_one(pool)
    .await?;
    Ok(progress.parse()?)
}
