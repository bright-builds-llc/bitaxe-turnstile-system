//! A `pool-adapter` process under test, and an Authority ingest that can crash it.

use std::{
    error::Error,
    net::SocketAddr,
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use bwg_core::pool_adapter_grpc::{
    self, AcceptedWorkIngestService, ChannelToken, accepted_work_ingest_router,
    proto::{
        DeliverAcceptedWorkRequest, DeliverAcceptedWorkResponse, ReportWorkerDisconnectRequest,
        ReportWorkerDisconnectResponse, accepted_work_ingest_server::AcceptedWorkIngest,
        deliver_accepted_work_response::Outcome,
    },
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::Notify,
};
use tonic::{Request, Response, Status};

pub(super) const WAIT_TIMEOUT: Duration = Duration::from_secs(10);
pub(super) const WAIT_POLL: Duration = Duration::from_millis(20);
pub(super) const CREDENTIAL_KEY: [u8; 32] = [27; 32];

/// The Authority's ingest, recording each event it credited.
///
/// Once armed, it kills the adapter process right after the Authority credits the
/// next event and never answers, as an adapter that dies before its outbox records
/// the acknowledgement.
#[derive(Clone)]
pub(super) struct CrashingAuthority {
    inner: AcceptedWorkIngestService,
    credited: Arc<Mutex<Vec<String>>>,
    armed: Arc<AtomicBool>,
    maybe_victim: Arc<Mutex<Option<AdapterProcess>>>,
    crashed: Arc<Notify>,
}

impl CrashingAuthority {
    pub(super) fn new(inner: AcceptedWorkIngestService) -> Self {
        Self {
            inner,
            credited: Arc::new(Mutex::new(Vec::new())),
            armed: Arc::new(AtomicBool::new(false)),
            maybe_victim: Arc::new(Mutex::new(None)),
            crashed: Arc::new(Notify::new()),
        }
    }

    pub(super) fn credits(&self) -> Result<Vec<String>, Box<dyn Error>> {
        Ok(self
            .credited
            .lock()
            .map_err(|_| "credit record lock is poisoned")?
            .clone())
    }

    pub(super) fn crash_after_next_credit(
        &self,
        victim: AdapterProcess,
    ) -> Result<(), Box<dyn Error>> {
        *self
            .maybe_victim
            .lock()
            .map_err(|_| "victim lock is poisoned")? = Some(victim);
        self.armed.store(true, Ordering::SeqCst);
        Ok(())
    }

    pub(super) async fn wait_for_credits(&self, count: usize) -> Result<(), Box<dyn Error>> {
        let deadline = tokio::time::Instant::now() + WAIT_TIMEOUT;
        while self.credits()?.len() < count {
            if tokio::time::Instant::now() >= deadline {
                return Err(format!("{count} credits never reached the Authority").into());
            }
            tokio::time::sleep(WAIT_POLL).await;
        }
        Ok(())
    }

    /// The event the Authority credited before the adapter died.
    pub(super) async fn wait_until_crashed(&self) -> Result<String, Box<dyn Error>> {
        tokio::time::timeout(WAIT_TIMEOUT, self.crashed.notified())
            .await
            .map_err(|_| "the adapter never crashed after a credit")?;
        self.credits()?
            .pop()
            .ok_or_else(|| "a crash must follow a credit".into())
    }

    fn kill_victim(&self) -> Result<(), Status> {
        let maybe_victim = self
            .maybe_victim
            .lock()
            .map_err(|_| Status::internal("victim lock is poisoned"))?
            .take();
        drop(maybe_victim);
        Ok(())
    }
}

#[async_trait]
impl AcceptedWorkIngest for CrashingAuthority {
    async fn deliver_accepted_work(
        &self,
        request: Request<DeliverAcceptedWorkRequest>,
    ) -> Result<Response<DeliverAcceptedWorkResponse>, Status> {
        let maybe_event_id = request
            .get_ref()
            .event
            .as_ref()
            .map(|event| event.event_id.clone());
        let response = self.inner.deliver_accepted_work(request).await?;
        if let (Some(Outcome::Credited(_)), Some(event_id)) =
            (&response.get_ref().outcome, maybe_event_id)
        {
            self.credited
                .lock()
                .map_err(|_| Status::internal("credit record lock is poisoned"))?
                .push(event_id);
        }
        if self.armed.swap(false, Ordering::SeqCst) {
            self.kill_victim()?;
            self.crashed.notify_one();
            std::future::pending::<()>().await;
        }
        Ok(response)
    }

    async fn report_worker_disconnect(
        &self,
        request: Request<ReportWorkerDisconnectRequest>,
    ) -> Result<Response<ReportWorkerDisconnectResponse>, Status> {
        self.inner.report_worker_disconnect(request).await
    }
}

pub(super) async fn serve_authority(
    authority: CrashingAuthority,
    token: &ChannelToken,
) -> Result<SocketAddr, Box<dyn Error>> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    tokio::spawn(pool_adapter_grpc::serve(
        accepted_work_ingest_router(authority, token),
        listener,
    ));
    Ok(address)
}

/// What every `pool-adapter` process of this test is started with.
pub(super) struct AdapterLaunch {
    pub(super) database_url: String,
    pub(super) authority_address: SocketAddr,
    pub(super) pool_address: SocketAddr,
    pub(super) token_value: String,
}

impl AdapterLaunch {
    /// Starts the binary on fresh loopback ports and waits for it to listen.
    ///
    /// It binds the proxy before the registry, so a listening registry means a
    /// listening proxy; probing the proxy would spend the Mining Pool's one connection.
    pub(super) async fn start(&self) -> Result<AdapterProcess, Box<dyn Error>> {
        self.start_with(&[]).await
    }

    /// Starts the binary with `extra_env` added and waits for it to listen.
    pub(super) async fn start_with(
        &self,
        extra_env: &[(&str, &str)],
    ) -> Result<AdapterProcess, Box<dyn Error>> {
        let (process, registry_address) = self.spawn_with(extra_env).await?;
        wait_for_listener(registry_address).await?;
        Ok(process)
    }

    /// Spawns the binary with `extra_env` added, returning it and its registry address
    /// without waiting for it to listen.
    pub(super) async fn spawn_with(
        &self,
        extra_env: &[(&str, &str)],
    ) -> Result<(AdapterProcess, SocketAddr), Box<dyn Error>> {
        let proxy_address = free_loopback_address().await?;
        let registry_address = free_loopback_address().await?;
        let child = Command::new(env!("CARGO_BIN_EXE_pool-adapter"))
            .env_clear()
            .env("BWG_POOL_ADAPTER_CHANNEL_TOKEN", &self.token_value)
            .env("BWG_POOL_ADAPTER_DATABASE_URL", &self.database_url)
            .env(
                "BWG_AUTHORITY_GRPC_URL",
                format!("http://{}", self.authority_address),
            )
            .env(
                "BWG_STRATUM_CREDENTIAL_KEY",
                URL_SAFE_NO_PAD.encode(CREDENTIAL_KEY),
            )
            .env(
                "BWG_WORKER_STRATUM_ENDPOINT",
                format!("stratum+tcp://{proxy_address}/"),
            )
            .env(
                "BWG_POOL_ADAPTER_GRPC_LISTEN_ADDRESS",
                registry_address.to_string(),
            )
            .env(
                "BWG_POOL_UPSTREAM_STRATUM_ADDRESS",
                self.pool_address.to_string(),
            )
            .env("BWG_POOL_UPSTREAM_PASSWORD", "x")
            .env(
                "BWG_STRATUM_PROXY_LISTEN_ADDRESS",
                proxy_address.to_string(),
            )
            .envs(extra_env.iter().copied())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        let process = AdapterProcess {
            child,
            proxy_address,
        };
        Ok((process, registry_address))
    }
}

/// One `pool-adapter` process; dropping it kills the process.
pub(super) struct AdapterProcess {
    pub(super) child: Child,
    pub(super) proxy_address: SocketAddr,
}

impl Drop for AdapterProcess {
    fn drop(&mut self) {
        if let Err(error) = self.child.kill() {
            tracing::warn!(%error, "pool-adapter test process was already gone");
        }
        if let Err(error) = self.child.wait() {
            tracing::warn!(%error, "pool-adapter test process was not reaped");
        }
    }
}

pub(super) async fn free_loopback_address() -> Result<SocketAddr, std::io::Error> {
    TcpListener::bind("127.0.0.1:0").await?.local_addr()
}

pub(super) async fn wait_for_listener(address: SocketAddr) -> Result<(), Box<dyn Error>> {
    let deadline = tokio::time::Instant::now() + WAIT_TIMEOUT;
    while TcpStream::connect(address).await.is_err() {
        if tokio::time::Instant::now() >= deadline {
            return Err("the pool-adapter process never listened".into());
        }
        tokio::time::sleep(WAIT_POLL).await;
    }
    Ok(())
}
