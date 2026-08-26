use std::{
    error::Error,
    net::SocketAddr,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use axum::Router;
use bitcoin::{Address, Amount, Network, Transaction, consensus::deserialize, hex::FromHex as _};
use bwg_core::{
    authority::{
        self, AuthorityApplication, AuthorityPublicConfig, CLIENT_ID_HEADER, Config,
        DeploymentEnvironment, ServiceCredential, SimulatedPoolAdapter,
    },
    challenge::{ActionPolicy, ChallengeId},
    lifecycle::WorkerClock,
    pool_offer::PoolSelection,
    progress::WorkSessionId,
    stratum_v1::{
        AcceptedWorkDeliveryWorker, AcceptedWorkSink, AcceptedWorkSinkError, DeliveryOutcome,
        PostgresAcceptedWorkOutbox, PostgresStratumSessionRegistry, StratumCredentialIssuer,
        StratumLeaseContext, StratumTcpProxy, StratumUpstreamAuthorization, StratumV1Error,
    },
};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt as _, BufReader},
    net::{
        TcpListener, TcpStream,
        tcp::{OwnedReadHalf, OwnedWriteHalf},
    },
    time::Duration,
};

#[path = "support/postgres.rs"]
mod postgres_support;
use postgres_support::PostgresTestDatabase;

#[path = "support/authority_keys.rs"]
mod authority_key_support;
use authority_key_support::{CLAIMANT_PUBLIC_JWK, authority_keys};

#[path = "hydra_solo_integration/protocol.rs"]
mod protocol;
use protocol::*;
#[path = "hydra_solo_integration/session_mismatch.rs"]
mod session_mismatch;

const CLIENT_ID: &str = "hydra-integration-service";
const SERVICE_SECRET: &str = "hydra-integration-secret-P9vK2mQ7xR4tY8uN3cF6wL1zA";
const AUTHORITY_SIGNING_SEED: &str = "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A";

#[tokio::test]
#[ignore = "run through scripts/verify-hydra-solo-integration.sh"]
async fn standard_worker_crosses_proxy_and_pinned_hydra_with_direct_payout()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let IntegrationFixture {
        _database,
        hydra_address,
        payout_script,
        adapter,
        outbox,
        sessions,
        credentials,
        upstream_authorization,
        now,
    } = arrange_integration().await?;
    let proxy = StratumTcpProxy::new(outbox.clone(), sessions.clone())
        .with_upstream_authorization(upstream_authorization.clone());
    let proxy_listener = TcpListener::bind("127.0.0.1:0").await?;
    let proxy_address = proxy_listener.local_addr()?;
    let mut proxy_task =
        tokio::spawn(async move { proxy.serve_one(&proxy_listener, hydra_address).await });
    let worker = TcpStream::connect(proxy_address).await?;
    let (worker_read, mut worker_write) = worker.into_split();
    let mut worker_lines = BufReader::new(worker_read).lines();

    // Act
    write_line(
        &mut worker_write,
        r#"{"id":1,"method":"mining.subscribe","params":[]}"#,
    )
    .await?;
    let subscribed = next_matching(&mut worker_lines, |value| value["id"] == 1)
        .await
        .map_err(|error| format!("waiting for subscribe: {error}"))?;
    let first_extranonce = subscribed["result"][1]
        .as_str()
        .ok_or("Hydra subscribe response must include extranonce1")?
        .to_owned();
    let extranonce2_size = subscribed["result"][2]
        .as_u64()
        .ok_or("Hydra subscribe response must include extranonce2 size")?;
    write_line(
        &mut worker_write,
        &format!(
            r#"{{"id":2,"method":"mining.authorize","params":["{}","{}"]}}"#,
            credentials.username(),
            credentials.secret()
        ),
    )
    .await?;
    let mut observed = Vec::new();
    let authorized =
        next_matching_recording(&mut worker_lines, |value| value["id"] == 2, &mut observed)
            .await
            .map_err(|error| format!("waiting for authorize: {error}"))?;
    let notify = next_matching_recording(
        &mut worker_lines,
        |value| value["method"] == "mining.notify",
        &mut observed,
    )
    .await
    .map_err(|error| format!("waiting for initial job: {error}"))?;
    let params = notify["params"]
        .as_array()
        .ok_or("Hydra notify params must be an array")?;
    let coinbase2 = params[3]
        .as_str()
        .ok_or("Hydra coinbase2 must be a string")?
        .to_ascii_lowercase();
    let coinbase1 = params[2]
        .as_str()
        .ok_or("Hydra coinbase1 must be a string")?;
    let extranonce2 = "00".repeat(usize::try_from(extranonce2_size)?);
    let coinbase_bytes = Vec::<u8>::from_hex(&format!(
        "{coinbase1}{first_extranonce}{extranonce2}{coinbase2}"
    ))?;
    let coinbase = deserialize::<Transaction>(&coinbase_bytes)?;
    let vardiff = exercise_vardiff(
        &mut worker_lines,
        &mut worker_write,
        &mut proxy_task,
        VardiffInput {
            username: credentials.username(),
            params,
            observed: &observed,
            extranonce1: &first_extranonce,
            extranonce2: &extranonce2,
        },
    )
    .await?;
    let delivery = AcceptedWorkDeliveryWorker::new(
        outbox.clone(),
        "delivery_worker_hydra_integration".to_owned(),
        30,
    )?;
    let sink = AuthoritySink {
        adapter,
        progress: Mutex::new(Vec::new()),
    };
    let mut delivered_count = 0;
    for offset in 1..=5 {
        match delivery.deliver_one(&sink, now + offset).await? {
            DeliveryOutcome::Acknowledged => delivered_count += 1,
            DeliveryOutcome::Empty => break,
            DeliveryOutcome::RetryableFailure => return Err("Authority delivery failed".into()),
        }
    }
    let progress = sink.progress.into_inner()?;

    // Assert
    assert_eq!(authorized["result"], true);
    assert_eq!(coinbase.output.len(), 2);
    assert_eq!(coinbase.output[0].script_pubkey, payout_script);
    assert_eq!(coinbase.output[0].value, Amount::from_sat(5_000_000_000));
    assert_eq!(coinbase.output[1].value, Amount::ZERO);
    assert!(coinbase.output[1].script_pubkey.is_op_return());
    assert_eq!(delivered_count, 4);
    assert_eq!(progress.len(), 4);
    assert!(
        progress
            .last()
            .ok_or("progress must exist")?
            .parse::<u128>()?
            >= 4
    );
    mine_regtest_block().await?;
    let replacement = next_matching(&mut worker_lines, |value| {
        value["method"] == "mining.notify" && value["params"][8] == true
    })
    .await?;
    assert_ne!(replacement["params"][0], vardiff.adjusted_job_id);
    write_line(
        &mut worker_write,
        &format!(
            r#"{{"id":8,"method":"mining.submit","params":["{}","{}","{extranonce2}","{}","{}"]}}"#,
            credentials.username(),
            vardiff.adjusted_job_id,
            vardiff.adjusted_ntime,
            vardiff.adjusted_nonce
        ),
    )
    .await?;
    wait_for_close(&mut worker_lines).await?;
    drop(worker_lines);
    drop(worker_write);
    assert!(matches!(proxy_task.await?, Err(StratumV1Error::UnknownJob)));

    submit_network_block_after_reconnect(
        outbox,
        sessions,
        upstream_authorization,
        hydra_address,
        &credentials,
        &first_extranonce,
    )
    .await?;
    Ok(())
}

async fn submit_network_block_after_reconnect(
    outbox: PostgresAcceptedWorkOutbox,
    sessions: PostgresStratumSessionRegistry,
    upstream_authorization: StratumUpstreamAuthorization,
    hydra_address: SocketAddr,
    credentials: &bwg_core::stratum_v1::StratumSessionCredentials,
    first_extranonce: &str,
) -> Result<(), Box<dyn Error>> {
    let proxy = StratumTcpProxy::new(outbox.clone(), sessions)
        .with_upstream_authorization(upstream_authorization);
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let proxy_task = tokio::spawn(async move { proxy.serve_one(&listener, hydra_address).await });
    let worker = TcpStream::connect(address).await?;
    let (worker_read, mut worker_write) = worker.into_split();
    let mut worker_lines = BufReader::new(worker_read).lines();
    write_line(
        &mut worker_write,
        r#"{"id":11,"method":"mining.subscribe","params":[]}"#,
    )
    .await?;
    let subscribed = next_matching(&mut worker_lines, |value| value["id"] == 11)
        .await
        .map_err(|error| format!("waiting for reconnect subscribe: {error}"))?;
    let extranonce1 = subscribed["result"][1]
        .as_str()
        .ok_or("reconnect response must include extranonce1")?
        .to_owned();
    let extranonce2 = "00".repeat(usize::try_from(
        subscribed["result"][2]
            .as_u64()
            .ok_or("reconnect response must include extranonce2 size")?,
    )?);
    write_line(
        &mut worker_write,
        &format!(
            r#"{{"id":12,"method":"mining.authorize","params":["{}","{}"]}}"#,
            credentials.username(),
            credentials.secret()
        ),
    )
    .await?;
    let mut observed = Vec::new();
    let authorized =
        next_matching_recording(&mut worker_lines, |value| value["id"] == 12, &mut observed)
            .await?;
    let notify = next_matching_recording(
        &mut worker_lines,
        |value| value["method"] == "mining.notify",
        &mut observed,
    )
    .await?;
    assert_eq!(authorized["result"], true);
    assert_ne!(extranonce1, first_extranonce);
    let difficulty = observed
        .iter()
        .find(|value| value["method"] == "mining.set_difficulty")
        .map(|value| value["params"][0].clone())
        .ok_or("reconnect must assign difficulty")?;
    let params = notify["params"]
        .as_array()
        .ok_or("reconnect notify params must be an array")?;
    let winning_nonce = worked_nonce(
        params,
        &extranonce1,
        &extranonce2,
        assigned_target(&difficulty)?,
        true,
        0,
    )?;
    let block_count_before = regtest_block_count().await?;
    outbox.close().await;
    write_line(
        &mut worker_write,
        &format!(
            r#"{{"id":13,"method":"mining.submit","params":["{}","{}","{extranonce2}","{}","{winning_nonce}"]}}"#,
            credentials.username(),
            params[0].as_str().ok_or("winning job ID")?,
            params[7].as_str().ok_or("winning ntime")?
        ),
    )
    .await?;
    wait_for_close(&mut worker_lines).await?;
    drop(worker_write);
    assert!(matches!(
        proxy_task.await?,
        Err(StratumV1Error::Database(_))
    ));
    wait_for_block_height(block_count_before + 1).await
}

struct VardiffEvidence {
    adjusted_job_id: String,
    adjusted_ntime: String,
    adjusted_nonce: String,
}

struct VardiffInput<'a> {
    username: &'a str,
    params: &'a [Value],
    observed: &'a [Value],
    extranonce1: &'a str,
    extranonce2: &'a str,
}

async fn exercise_vardiff(
    worker_lines: &mut tokio::io::Lines<BufReader<OwnedReadHalf>>,
    worker_write: &mut OwnedWriteHalf,
    proxy_task: &mut tokio::task::JoinHandle<Result<(), StratumV1Error>>,
    input: VardiffInput<'_>,
) -> Result<VardiffEvidence, Box<dyn Error>> {
    let VardiffInput {
        username,
        params,
        observed,
        extranonce1,
        extranonce2,
    } = input;
    let job_id = params[0].as_str().ok_or("Hydra job ID must be a string")?;
    let ntime = params[7].as_str().ok_or("Hydra ntime must be a string")?;
    let initial_difficulty = observed
        .iter()
        .find(|value| value["method"] == "mining.set_difficulty")
        .map(|value| value["params"][0].clone())
        .ok_or("Hydra must assign an initial difficulty")?;
    let initial_target = assigned_target(&initial_difficulty)?;
    let mut accepted = Vec::new();
    let mut minimum_nonce = 0;
    for request_id in 3..=5 {
        let nonce = worked_nonce(
            params,
            extranonce1,
            extranonce2,
            initial_target,
            false,
            minimum_nonce,
        )?;
        write_line(
            worker_write,
            &format!(
                r#"{{"id":{request_id},"method":"mining.submit","params":["{}","{job_id}","{extranonce2}","{ntime}","{nonce}"]}}"#,
                username
            ),
        )
        .await?;
        let response = match next_matching(worker_lines, |value| value["id"] == request_id).await {
            Ok(value) => value,
            Err(error) => {
                return Err(format!(
                    "waiting for accepted share {request_id}: {error}; proxy result: {:?}",
                    proxy_task.await?
                )
                .into());
            }
        };
        accepted.push(response);
        minimum_nonce = u32::from_str_radix(&nonce, 16)? + 1;
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let adjusted_difficulty = next_matching(worker_lines, |value| {
        value["method"] == "mining.set_difficulty" && value["params"][0] != initial_difficulty
    })
    .await
    .map_err(|error| format!("waiting for adjusted difficulty: {error}"))?;
    let adjusted_notify = next_matching(worker_lines, |value| value["method"] == "mining.notify")
        .await
        .map_err(|error| format!("waiting for adjusted job: {error}"))?;
    let adjusted_params = adjusted_notify["params"]
        .as_array()
        .ok_or("adjusted Hydra notify params must be an array")?;
    let adjusted_job_id = adjusted_params[0]
        .as_str()
        .ok_or("adjusted Hydra job ID must be a string")?
        .to_owned();
    let adjusted_ntime = adjusted_params[7]
        .as_str()
        .ok_or("adjusted Hydra ntime must be a string")?
        .to_owned();
    let adjusted_nonce = worked_nonce(
        adjusted_params,
        extranonce1,
        extranonce2,
        assigned_target(&adjusted_difficulty["params"][0])?,
        false,
        0,
    )?;
    write_line(
        worker_write,
        &format!(
            r#"{{"id":6,"method":"mining.submit","params":["{}","{adjusted_job_id}","{extranonce2}","{adjusted_ntime}","{adjusted_nonce}"]}}"#,
            username
        ),
    )
    .await?;
    let adjusted_accepted = next_matching(worker_lines, |value| value["id"] == 6).await?;
    write_line(
        worker_write,
        &format!(
            r#"{{"id":7,"method":"mining.submit","params":["{}","{adjusted_job_id}","{extranonce2}","{adjusted_ntime}","{adjusted_nonce}"]}}"#,
            username
        ),
    )
    .await?;
    let rejected_duplicate = next_matching(worker_lines, |value| value["id"] == 7).await?;

    assert!(accepted.iter().all(|response| response["result"] == true));
    assert_eq!(adjusted_accepted["result"], true);
    assert_ne!(rejected_duplicate["result"], true);
    assert!(rejected_duplicate["error"].is_array());
    assert_eq!(initial_difficulty, serde_json::json!(0.0000000001));
    assert_ne!(adjusted_difficulty["params"][0], initial_difficulty);
    Ok(VardiffEvidence {
        adjusted_job_id,
        adjusted_ntime,
        adjusted_nonce,
    })
}

struct IntegrationFixture {
    _database: PostgresTestDatabase,
    hydra_address: SocketAddr,
    payout_script: bitcoin::ScriptBuf,
    adapter: SimulatedPoolAdapter,
    outbox: PostgresAcceptedWorkOutbox,
    sessions: PostgresStratumSessionRegistry,
    credentials: bwg_core::stratum_v1::StratumSessionCredentials,
    upstream_authorization: StratumUpstreamAuthorization,
    now: u64,
}

async fn arrange_integration() -> Result<IntegrationFixture, Box<dyn Error>> {
    let hydra_address = std::env::var("BWG_HYDRA_STRATUM_ADDR")?.parse::<SocketAddr>()?;
    let payout_address = std::env::var("BWG_HYDRA_PAYOUT_ADDRESS")?;
    let payout_script = payout_address
        .parse::<Address<_>>()?
        .require_network(Network::Bitcoin)?
        .script_pubkey();
    let database = PostgresTestDatabase::start().await?;
    let application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let adapter = application.simulated_pool_adapter();
    let authority_url = spawn_http(authority::router(application)).await?;
    let challenge = reqwest::Client::new()
        .post(format!("{authority_url}/v0/challenges"))
        .header(CLIENT_ID_HEADER, CLIENT_ID)
        .bearer_auth(SERVICE_SECRET)
        .json(&serde_json::json!({
            "action_policy": "account-creation.light.v1",
            "action_reference": "action_hydra_solo_integration_01",
            "claimant_key": CLAIMANT_PUBLIC_JWK
        }))
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    let challenge_id = ChallengeId::try_from(
        challenge["challenge_id"]
            .as_str()
            .ok_or("challenge response needs an identifier")?
            .to_owned(),
    )?;
    let outbox = PostgresAcceptedWorkOutbox::connect(database.database_url()).await?;
    let sessions = PostgresStratumSessionRegistry::connect(database.database_url()).await?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let session_id = WorkSessionId::try_from("session_hydra_solo_integration_01".to_owned())?;
    let selection =
        PoolSelection::bitcoin_address("pool_offer_hydra_solo_v1".to_owned(), payout_address)?;
    let selection_commitment = adapter
        .consent_pool_selection_for_simulation(&challenge_id, &selection)
        .await?;
    adapter
        .register_session(&challenge_id, session_id.clone())
        .await?;
    let lease = adapter
        .start_lease(
            &session_id,
            WorkerClock::new("boot_hydra_solo_integration", 0)?,
        )
        .await?;
    let lease_context = StratumLeaseContext::new(
        lease.lease_id().to_owned(),
        "boot_hydra_solo_integration".to_owned(),
        0,
        lease.renew_at_monotonic_milliseconds(),
        lease.expires_at_monotonic_milliseconds(),
    )?;
    let credentials = StratumCredentialIssuer::new([31_u8; 32]).issue(
        session_id.clone(),
        lease_context,
        now,
        now + 60,
        now + 300,
    )?;
    sessions.register(&credentials).await?;
    let upstream_authorization = adapter
        .upstream_authorization_for_simulation(&session_id, &selection, "x".to_owned())
        .await?;
    assert_eq!(
        upstream_authorization.payout_commitment(),
        selection_commitment.commitment()
    );
    Ok(IntegrationFixture {
        _database: database,
        hydra_address,
        payout_script,
        adapter,
        outbox,
        sessions,
        credentials,
        upstream_authorization,
        now,
    })
}

struct AuthoritySink {
    adapter: SimulatedPoolAdapter,
    progress: Mutex<Vec<String>>,
}

#[async_trait]
impl AcceptedWorkSink for AuthoritySink {
    async fn deliver(
        &self,
        event: bwg_core::progress::AcceptedWorkEvent,
        lease_context: StratumLeaseContext,
    ) -> Result<(), AcceptedWorkSinkError> {
        let acknowledgement = self
            .adapter
            .report_stratum(event, &lease_context)
            .await
            .map_err(|_| AcceptedWorkSinkError::Unavailable)?;
        self.progress
            .lock()
            .map_err(|_| AcceptedWorkSinkError::Unavailable)?
            .push(acknowledgement.verified_progress().to_decimal_string());
        Ok(())
    }
}

fn authority_config() -> Result<Config, Box<dyn Error>> {
    let credential = ServiceCredential::new(
        CLIENT_ID,
        SERVICE_SECRET,
        DeploymentEnvironment::Development,
        "https://relying.example".to_owned(),
        vec!["https://app.relying.example".to_owned()],
        vec![ActionPolicy::AccountCreationLightV1],
    )?;
    let public = AuthorityPublicConfig::new(
        "https://authority.example",
        "https://authority.example",
        authority_keys()?,
        "https://authority.example/policies/operator",
        "https://authority.example/privacy",
        "https://authority.example/terms",
    )?;
    Ok(
        Config::new(DeploymentEnvironment::Development, vec![credential], public)?
            .with_signing_key_seed("authority-a".to_owned(), AUTHORITY_SIGNING_SEED)?,
    )
}

async fn spawn_http(router: Router) -> Result<String, std::io::Error> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("test server should run until its task is dropped");
    });
    Ok(format!("http://{address}"))
}
