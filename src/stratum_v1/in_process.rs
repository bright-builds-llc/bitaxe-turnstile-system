//! The Pool Adapter's proxy, accepted-work delivery and Pool Selection expiry sweep,
//! run in the Authority's process until its own gRPC process exists (ADR-0109).

use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use tokio::{
    net::{TcpListener, TcpStream},
    task::JoinSet,
};

use uuid::Uuid;

use super::{
    AcceptedWorkDeliveryWorker, AcceptedWorkSink, DeliveryOutcome, PostgresAcceptedWorkOutbox,
    PostgresStratumSessionRegistry, StratumTcpProxy, StratumV1Error, WorkSessionDisconnectSink,
};

const DELIVERY_INTERVAL: Duration = Duration::from_millis(250);
const DELIVERY_LEASE_SECONDS: u64 = 30;
const SWEEP_INTERVAL: Duration = Duration::from_secs(5);

/// Where the in-process Pool Adapter listens and which Mining Pool it forwards to.
pub struct InProcessPoolAdapterConfig {
    /// The Pool Adapter's own database, with its own migrations.
    pub database_url: String,
    /// The Mining Pool's Stratum V1 address, as `host:port`.
    pub upstream_address: String,
    /// The Mining Pool-facing password; each session's username comes from its Pool Selection.
    pub upstream_password: String,
}

/// Starts the proxy on `listener`, delivery into `port` and the expiry sweep.
///
/// The tasks run until the returned set is dropped.
pub async fn spawn_in_process_pool_adapter<P>(
    config: InProcessPoolAdapterConfig,
    listener: TcpListener,
    port: P,
) -> Result<JoinSet<()>, StratumV1Error>
where
    P: AcceptedWorkSink + WorkSessionDisconnectSink + Clone + 'static,
{
    let outbox = PostgresAcceptedWorkOutbox::connect(&config.database_url).await?;
    let registry = PostgresStratumSessionRegistry::connect(&config.database_url).await?;
    let proxy = StratumTcpProxy::new(outbox.clone(), registry.clone(), Arc::new(port.clone()))
        .with_session_upstream_authorization(config.upstream_password)?;
    let delivery = AcceptedWorkDeliveryWorker::new(
        outbox,
        format!("delivery_worker_{}", Uuid::new_v4().simple()),
        DELIVERY_LEASE_SECONDS,
    )?;
    let mut tasks = JoinSet::new();
    tasks.spawn(accept_workers(listener, proxy, config.upstream_address));
    tasks.spawn(deliver_accepted_work(delivery, port));
    tasks.spawn(sweep_expired_selections(registry));
    Ok(tasks)
}

async fn accept_workers(listener: TcpListener, proxy: StratumTcpProxy, upstream_address: String) {
    loop {
        let worker = match listener.accept().await {
            Ok((worker, _)) => worker,
            Err(error) => {
                tracing::error!(%error, "Stratum proxy stopped accepting Workers");
                return;
            }
        };
        let proxy = proxy.clone();
        let upstream_address = upstream_address.clone();
        tokio::spawn(async move {
            let upstream = match TcpStream::connect(&upstream_address).await {
                Ok(upstream) => upstream,
                Err(error) => {
                    tracing::warn!(%error, "Mining Pool is unreachable");
                    return;
                }
            };
            if let Err(error) = proxy.admit_and_run(worker, upstream).await {
                tracing::info!(%error, "Stratum session ended");
            }
        });
    }
}

async fn deliver_accepted_work<S: AcceptedWorkSink>(delivery: AcceptedWorkDeliveryWorker, sink: S) {
    let mut interval = tokio::time::interval(DELIVERY_INTERVAL);
    loop {
        interval.tick().await;
        let Some(now) = now_unix_seconds() else {
            tracing::error!("system clock is unavailable to accepted-work delivery");
            continue;
        };
        match delivery.deliver_one(&sink, now).await {
            Ok(DeliveryOutcome::Empty) => {}
            Ok(DeliveryOutcome::Refused(refusal)) => {
                tracing::info!(reason = refusal.code(), "accepted work refused");
            }
            Ok(outcome) => tracing::debug!(?outcome, "accepted work delivered"),
            Err(error) => tracing::warn!(%error, "accepted-work delivery iteration failed"),
        }
    }
}

async fn sweep_expired_selections(registry: PostgresStratumSessionRegistry) {
    let mut interval = tokio::time::interval(SWEEP_INTERVAL);
    loop {
        interval.tick().await;
        let Some(now) = now_unix_seconds() else {
            tracing::error!("system clock is unavailable to the Pool Selection sweep");
            continue;
        };
        match registry.delete_expired_pool_selections(now).await {
            Ok(0) => {}
            Ok(swept) => tracing::info!(swept, "expired Pool Selections removed"),
            Err(error) => tracing::warn!(%error, "Pool Selection sweep failed"),
        }
    }
}

fn now_unix_seconds() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|elapsed| elapsed.as_secs())
}
