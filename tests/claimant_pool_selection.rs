//! Claimant Pool Selection keeps the raw payout choice at the Pool Adapter only (ADR-0107).

use std::{
    error::Error,
    io::Write,
    sync::{Arc, Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use bwg_core::{
    challenge::ChallengeId,
    pool_offer::PoolSelection,
    stratum_v1::{PostgresStratumSessionRegistry, StratumLeaseContext},
};
use reqwest::StatusCode;
use serde_json::{Value, json};
use sqlx::{PgPool, Row as _};

#[path = "support/authority_keys.rs"]
mod authority_key_support;
#[path = "support/claimant.rs"]
mod claimant_support;
#[path = "support/claimant_work_session.rs"]
mod fixture;
#[path = "support/postgres.rs"]
mod postgres_support;
#[allow(dead_code)]
#[path = "support/running_server.rs"]
mod running_server;
#[allow(dead_code)]
#[path = "support/work_session.rs"]
mod work_session_support;
use fixture::{CONTROL_SESSION, Fixture, claimant_session_id};
use postgres_support::PostgresTestDatabase;
use work_session_support::accepted_event;

/// A public, well-known address that appears nowhere else in these tests.
const PAYOUT_ADDRESS: &str = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const OTHER_PAYOUT_ADDRESS: &str = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
const POOL_OFFER_ID: &str = "pool_offer_hydra_solo_v1";

static CAPTURED_LOGS: OnceLock<Arc<Mutex<Vec<u8>>>> = OnceLock::new();

struct CapturedLogWriter(Arc<Mutex<Vec<u8>>>);

impl Write for CapturedLogWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .map_err(|_| std::io::Error::other("log buffer lock was poisoned"))?
            .extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Captures every log line this test process emits, at every level.
fn captured_logs() -> Arc<Mutex<Vec<u8>>> {
    CAPTURED_LOGS
        .get_or_init(|| {
            let buffer = Arc::new(Mutex::new(Vec::new()));
            let writer_buffer = buffer.clone();
            tracing_subscriber::fmt()
                .with_ansi(false)
                .with_max_level(tracing::Level::TRACE)
                .with_writer(move || CapturedLogWriter(writer_buffer.clone()))
                .init();
            buffer
        })
        .clone()
}

fn selection_body(address: &str) -> Value {
    json!({
        "pool_offer_id": POOL_OFFER_ID,
        "payout_destination_type": "bitcoin_mainnet_address",
        "payout_destination": address
    })
}

fn now_unix_milliseconds() -> Result<u64, Box<dyn Error>> {
    Ok(u64::try_from(
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis(),
    )?)
}

async fn select(fixture: &Fixture, address: &str) -> Result<reqwest::Response, Box<dyn Error>> {
    fixture
        .post("pool-selection", &selection_body(address))
        .await
}

/// Every row of every table outside the Pool Adapter's schema, as JSON text.
async fn authority_rows(database: &PostgresTestDatabase) -> Result<String, Box<dyn Error>> {
    let pool = PgPool::connect(database.database_url()).await?;
    let tables = sqlx::query(
        "SELECT table_schema, table_name FROM information_schema.tables
         WHERE table_type = 'BASE TABLE'
           AND table_schema NOT IN ('pg_catalog', 'information_schema', 'pool_adapter')",
    )
    .fetch_all(&pool)
    .await?;
    let mut rows = String::new();
    for table in tables {
        let schema = table.try_get::<String, _>("table_schema")?;
        let name = table.try_get::<String, _>("table_name")?;
        let text = sqlx::query_scalar::<_, Option<String>>(&format!(
            "SELECT string_agg(row_to_json(row)::text, '\n') FROM \"{schema}\".\"{name}\" AS row"
        ))
        .fetch_one(&pool)
        .await?;
        rows.push_str(&text.unwrap_or_default());
    }
    pool.close().await;
    Ok(rows)
}

async fn stored_selection_count(
    database: &PostgresTestDatabase,
    challenge_id: &ChallengeId,
) -> Result<i64, Box<dyn Error>> {
    let pool = PgPool::connect(database.database_url()).await?;
    let count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pool_adapter.session_pool_selections WHERE challenge_id = $1",
    )
    .bind(challenge_id.as_str())
    .fetch_one(&pool)
    .await?;
    pool.close().await;
    Ok(count)
}

#[tokio::test]
async fn authority_keeps_only_the_commitment_in_rows_and_logs() -> Result<(), Box<dyn Error>> {
    // Arrange
    let logs = captured_logs();
    let fixture = Fixture::start_unselected().await?;

    // Act
    let response = select(&fixture, PAYOUT_ADDRESS).await?;
    let status = response.status();
    let body = response.text().await?;
    fixture.start_work().await?;
    let rows = authority_rows(&fixture.database).await?;

    // Assert
    let commitment = serde_json::from_str::<Value>(&body)?["payout_commitment"]
        .as_str()
        .ok_or("the answer carries the commitment")?
        .to_owned();
    let logged = String::from_utf8(
        logs.lock()
            .map_err(|_| "log buffer lock was poisoned")?
            .clone(),
    )?;
    assert_eq!(status, StatusCode::OK);
    assert!(!body.contains(PAYOUT_ADDRESS));
    assert!(rows.contains(&commitment));
    assert!(!rows.contains(PAYOUT_ADDRESS));
    assert!(!logged.is_empty());
    assert!(!logged.contains(PAYOUT_ADDRESS));
    Ok(())
}

#[tokio::test]
async fn pool_adapter_derives_the_pool_facing_identity_from_the_stored_choice()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let fixture = Fixture::start_unselected().await?;
    let registry = PostgresStratumSessionRegistry::connect(fixture.database.database_url()).await?;
    let response: Value = select(&fixture, PAYOUT_ADDRESS)
        .await?
        .error_for_status()?
        .json()
        .await?;

    // Act
    let maybe_authorization = registry
        .session_upstream_authorization(
            &claimant_session_id(&fixture.challenge_id)?,
            "x",
            now_unix_milliseconds()? / 1_000,
        )
        .await?;

    // Assert
    let authorization = maybe_authorization.ok_or("the stored choice must authorize")?;
    assert_eq!(
        Some(authorization.payout_commitment()),
        response["payout_commitment"].as_str()
    );
    Ok(())
}

#[tokio::test]
async fn claimant_cancel_deletes_the_stored_choice() -> Result<(), Box<dyn Error>> {
    // Arrange
    let fixture = Fixture::start_unselected().await?;
    select(&fixture, PAYOUT_ADDRESS).await?.error_for_status()?;
    let stored_before = stored_selection_count(&fixture.database, &fixture.challenge_id).await?;

    // Act
    fixture
        .post("cancel", &json!({ "confirm_progress_loss": true }))
        .await?
        .error_for_status()?;

    // Assert
    assert_eq!(stored_before, 1);
    assert_eq!(
        stored_selection_count(&fixture.database, &fixture.challenge_id).await?,
        0
    );
    Ok(())
}

#[tokio::test]
async fn satisfied_challenge_deletes_the_stored_choice() -> Result<(), Box<dyn Error>> {
    // Arrange
    let fixture = Fixture::start_unselected().await?;
    select(&fixture, PAYOUT_ADDRESS).await?.error_for_status()?;
    let grant = fixture.start_work().await?;
    let now = now_unix_milliseconds()?;
    let lease_context = StratumLeaseContext::new(
        grant["leaseId"].as_str().ok_or("lease ID")?.to_owned(),
        CONTROL_SESSION.to_owned(),
        now,
        now + 20_000,
        now + 60_000,
    )?;
    let event = accepted_event(
        "event_pool_selection_satisfied_01",
        "share_pool_selection_satisfied_01",
        claimant_session_id(&fixture.challenge_id)?,
        0x01,
        now / 1_000,
    )?;

    // Act
    let acknowledgement = fixture
        .application
        .simulated_pool_adapter()
        .report_stratum(event, &lease_context)
        .await?;

    // Assert
    assert!(acknowledgement.issuance_intent_created());
    assert_eq!(
        stored_selection_count(&fixture.database, &fixture.challenge_id).await?,
        0
    );
    Ok(())
}

#[tokio::test]
async fn expired_choice_is_deleted_when_looked_up() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let registry = PostgresStratumSessionRegistry::connect(database.database_url()).await?;
    let challenge_id = ChallengeId::try_from("challenge_poolselectionexpiry01".to_owned())?;
    let session_id = claimant_session_id(&challenge_id)?;
    let selection =
        PoolSelection::bitcoin_address(POOL_OFFER_ID.to_owned(), PAYOUT_ADDRESS.to_owned())?;
    registry
        .record_pool_selection(&session_id, &challenge_id, &selection, 2_000, 1_000)
        .await?;

    // Act
    let at_expiry = registry
        .session_upstream_authorization(&session_id, "x", 2_000)
        .await?;

    // Assert
    assert!(at_expiry.is_none());
    assert_eq!(stored_selection_count(&database, &challenge_id).await?, 0);
    Ok(())
}

#[tokio::test]
async fn consented_choice_is_locked_and_replays_succeed() -> Result<(), Box<dyn Error>> {
    // Arrange
    let fixture = Fixture::start_unselected().await?;
    select(&fixture, PAYOUT_ADDRESS).await?.error_for_status()?;

    // Act
    let replayed = select(&fixture, PAYOUT_ADDRESS).await?.status();
    let changed = select(&fixture, OTHER_PAYOUT_ADDRESS).await?;

    // Assert
    assert_eq!(replayed, StatusCode::OK);
    assert_eq!(changed.status(), StatusCode::CONFLICT);
    assert_eq!(
        changed.json::<Value>().await?["error"],
        "pool_selection_locked"
    );
    Ok(())
}
