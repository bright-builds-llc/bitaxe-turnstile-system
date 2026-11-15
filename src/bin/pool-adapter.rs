//! The Pool Adapter process (ADR-0055, ADR-0113): the Stratum V1 proxy, accepted-work
//! delivery and the Pool Selection expiry sweep, with its own database, reaching the
//! Gate Authority only over the loopback gRPC boundary.

use std::{env, error::Error};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use bwg_core::{
    pool_adapter_grpc::{
        self, ChannelToken, GrpcAuthorityPort, StratumSessionRegistryService,
        loopback_listen_address, stratum_session_registry_router,
    },
    stratum_v1::{
        PoolAdapterWorkerStratum, PostgresStratumSessionRegistry, StratumCredentialIssuer,
        process::{PoolAdapterConfig, spawn_pool_adapter},
    },
};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error + Send + Sync>> {
    tracing_subscriber::fmt().try_init()?;
    let token = ChannelToken::try_from(env::var("BWG_POOL_ADAPTER_CHANNEL_TOKEN")?)?;
    let database_url = env::var("BWG_POOL_ADAPTER_DATABASE_URL")?;
    let authority = GrpcAuthorityPort::connect_lazy(&env::var("BWG_AUTHORITY_GRPC_URL")?, &token)?;
    let credential_key =
        <[u8; 32]>::try_from(URL_SAFE_NO_PAD.decode(env::var("BWG_STRATUM_CREDENTIAL_KEY")?)?)
            .map_err(|_| "BWG_STRATUM_CREDENTIAL_KEY must hold 32 base64url bytes")?;
    let stratum = PoolAdapterWorkerStratum::new(
        env::var("BWG_WORKER_STRATUM_ENDPOINT")?,
        StratumCredentialIssuer::new(credential_key),
        PostgresStratumSessionRegistry::connect(&database_url).await?,
    )?;
    let registry_address =
        loopback_listen_address(&env::var("BWG_POOL_ADAPTER_GRPC_LISTEN_ADDRESS")?)?;
    let config = PoolAdapterConfig {
        database_url,
        upstream_address: env::var("BWG_POOL_UPSTREAM_STRATUM_ADDRESS")?,
        upstream_password: env::var("BWG_POOL_UPSTREAM_PASSWORD")?,
    };
    let proxy_address = env::var("BWG_STRATUM_PROXY_LISTEN_ADDRESS")?;

    // The proxy binds first, so a listening registry means the whole process is ready.
    let proxy_listener = TcpListener::bind(&proxy_address).await?;
    let registry_listener = TcpListener::bind(registry_address).await?;
    let mut tasks = spawn_pool_adapter(config, proxy_listener, authority).await?;
    let registry =
        stratum_session_registry_router(StratumSessionRegistryService::new(stratum), &token);
    tasks.spawn(async move {
        if let Err(error) = pool_adapter_grpc::serve(registry, registry_listener).await {
            tracing::error!(%error, "Stratum session registry stopped serving");
        }
    });
    tracing::info!(%registry_address, "Stratum session registry listening");
    tracing::info!(%proxy_address, "Stratum proxy listening");

    // Every task runs for the process's life, so one that ends stops the process.
    tasks.join_next().await;
    Err("a Pool Adapter task stopped".into())
}
