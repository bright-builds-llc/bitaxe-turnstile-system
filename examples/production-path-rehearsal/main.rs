//! Production-path rehearsal harness (Ticket 06, ADR-0109). Test keys only.
//!
//! Starts PostgreSQL with the Authority, Reference Relying Service and Pool Adapter
//! databases, prints the test-key environment for the production `gate-authority`
//! and `reference-service` binaries, and serves a loopback control listener for the
//! local CPU miner and the rehearsal's synthetic share. The binaries never see the
//! control listener, and no production binary or route can reach the synthetic share.

use std::{
    error::Error,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use bwg_core::stratum_v1::PostgresAcceptedWorkOutbox;
use ring::rand::{SecureRandom as _, SystemRandom};
use serde_json::{Value, json};
use sqlx::postgres::PgPoolOptions;
use tokio::net::TcpListener;

#[path = "../../tests/support/authority_keys.rs"]
mod authority_key_support;
mod control;
mod miner;
#[path = "../../tests/support/postgres.rs"]
mod postgres_support;
#[path = "../../tests/support/stratum_hash.rs"]
mod stratum_hash_support;
mod synthetic;

use authority_key_support::authority_keys;
use postgres_support::PostgresTestDatabase;

const CLIENT_ID: &str = "rehearsal-reference-service";
const SERVICE_SECRET: &str = "rehearsal-reference-secret-T4nQ8vL2pX6sK9mW3dR7yB";
const AUTHORITY_SIGNING_SEED: &str = "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A";
const WORK_LEASE_AUTHORITY: &str = "test-work-lease-authority";
const ACTION_POLICY: &str = "account-creation.standard.v1";

/// Addresses the rehearsal script chose for the origin and the binaries.
struct Addresses {
    origin: String,
    gate: String,
    reference: String,
    proxy: String,
    hydra: String,
}

impl Addresses {
    fn from_env() -> Result<Self, Box<dyn Error>> {
        let var = |name: &str| std::env::var(name).map_err(|_| format!("{name} is required"));
        Ok(Self {
            origin: var("BWG_REHEARSAL_ORIGIN")?,
            gate: var("BWG_REHEARSAL_GATE_ADDRESS")?,
            reference: var("BWG_REHEARSAL_REFERENCE_ADDRESS")?,
            proxy: var("BWG_REHEARSAL_PROXY_ADDRESS")?,
            hydra: var("BWG_HYDRA_STRATUM_ADDR")?,
        })
    }
}

/// Database URLs, one per bounded context, in one container.
struct Databases {
    authority: String,
    relying_service: String,
    pool_adapter: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .init();
    let addresses = Addresses::from_env()?;
    let database = PostgresTestDatabase::start().await?;
    let databases = Databases {
        authority: database.database_url().to_owned(),
        relying_service: separate_database(database.database_url(), "relying_service").await?,
        pool_adapter: separate_database(database.database_url(), "pool_adapter").await?,
    };
    let control_listener = TcpListener::bind("127.0.0.1:0").await?;
    let control_address = control_listener.local_addr()?;
    let outbox = PostgresAcceptedWorkOutbox::connect(&databases.pool_adapter).await?;
    let control_state = control::ControlState::new(&databases.pool_adapter, outbox).await?;
    tokio::spawn(async move {
        if let Err(error) = axum::serve(control_listener, control::router(control_state)).await {
            tracing::error!(%error, "rehearsal control stopped");
        }
    });
    let keys = serde_json::to_string(&authority_keys()?)?;
    println!(
        "{}",
        json!({
            "origin": addresses.origin,
            "control": format!("http://{control_address}"),
            "authorityTrust": { "issuer": addresses.origin, "trustedKeys": authority_keys()? },
            "env": {
                "gateAuthority": gate_authority_env(&addresses, &databases, &keys)?,
                "referenceService": reference_service_env(&addresses, &databases, &keys),
            },
        })
    );
    std::future::pending::<()>().await;
    drop(database);
    Ok(())
}

fn gate_authority_env(
    addresses: &Addresses,
    databases: &Databases,
    keys: &str,
) -> Result<Value, Box<dyn Error>> {
    let origin = &addresses.origin;
    Ok(json!({
        "BWG_ENVIRONMENT": "development",
        "BWG_LISTEN_ADDRESS": addresses.gate,
        "BWG_SERVICE_CLIENT_ID": CLIENT_ID,
        "BWG_SERVICE_CREDENTIAL": SERVICE_SECRET,
        "BWG_RELYING_SERVICE_AUDIENCE": origin,
        "BWG_ALLOWED_ORIGINS": origin,
        "BWG_ALLOWED_ACTION_POLICIES": ACTION_POLICY,
        "BWG_AUTHORITY_ISSUER": origin,
        "BWG_AUTHORITY_PUBLIC_BASE_URL": origin,
        "BWG_AUTHORITY_JWKS_JSON": keys,
        "BWG_AUTHORITY_SIGNING_KID": "authority-a",
        "BWG_AUTHORITY_SIGNING_SEED": AUTHORITY_SIGNING_SEED,
        "BWG_OPERATOR_POLICY_URL": format!("{origin}/policies/operator"),
        "BWG_PRIVACY_URL": format!("{origin}/privacy"),
        "BWG_TERMS_URL": format!("{origin}/terms"),
        "BWG_AUTHORITY_DATABASE_URL": databases.authority,
        "BWG_WORK_LEASE_AUTHORITY_KID": WORK_LEASE_AUTHORITY,
        "BWG_WORK_LEASE_AUTHORITY_ISSUER": WORK_LEASE_AUTHORITY,
        "BWG_WORK_LEASE_AUTHORITY_SEED": test_work_lease_seed()?,
        "BWG_STRATUM_CREDENTIAL_KEY": URL_SAFE_NO_PAD.encode(random_key()?),
        "BWG_POOL_ADAPTER_DATABASE_URL": databases.pool_adapter,
        "BWG_WORKER_STRATUM_ENDPOINT": format!("stratum+tcp://{}/", addresses.proxy),
        "BWG_STRATUM_PROXY_LISTEN_ADDRESS": addresses.proxy,
        "BWG_POOL_UPSTREAM_STRATUM_ADDRESS": addresses.hydra,
        "BWG_POOL_UPSTREAM_PASSWORD": "x",
    }))
}

fn reference_service_env(addresses: &Addresses, databases: &Databases, keys: &str) -> Value {
    let origin = &addresses.origin;
    json!({
        "BWG_LISTEN_ADDRESS": addresses.reference,
        "BWG_AUTHORITY_BASE_URL": format!("http://{}", addresses.gate),
        "BWG_SERVICE_CLIENT_ID": CLIENT_ID,
        "BWG_SERVICE_CREDENTIAL": SERVICE_SECRET,
        "BWG_TRUSTED_AUTHORITY_ISSUER": origin,
        "BWG_TRUSTED_AUTHORITY_JWKS_JSON": keys,
        "BWG_RELYING_SERVICE_AUDIENCE": origin,
        "BWG_REDEMPTION_URL": format!("{origin}/account-creation/redeem"),
        "BWG_RELYING_SERVICE_DATABASE_URL": databases.relying_service,
    })
}

/// Each bounded context keeps its own database (ADR-0109), here in one container.
async fn separate_database(database_url: &str, name: &str) -> Result<String, Box<dyn Error>> {
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(database_url)
        .await?;
    sqlx::query(&format!("CREATE DATABASE {name}"))
        .execute(&pool)
        .await?;
    pool.close().await;
    let (base, _) = database_url
        .rsplit_once('/')
        .ok_or("database URL needs a database name")?;
    Ok(format!("{base}/{name}"))
}

fn random_key() -> Result<[u8; 32], Box<dyn Error>> {
    let mut key = [0_u8; 32];
    SystemRandom::new()
        .fill(&mut key)
        .map_err(|_| "random credential key")?;
    Ok(key)
}

/// The shared test Work Lease Authority seed, which the fake serial device trusts.
fn test_work_lease_seed() -> Result<String, Box<dyn Error>> {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../conformance/bwg-worker-deployment-trust-0.2/authority-signer-vectors.json"
    ))?;
    Ok(vectors["seedBase64Url"]
        .as_str()
        .ok_or("vector seed")?
        .to_owned())
}

pub(crate) fn now_unix_seconds() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|elapsed| elapsed.as_secs())
}
