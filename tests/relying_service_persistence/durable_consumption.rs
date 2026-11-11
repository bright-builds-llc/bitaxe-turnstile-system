//! Waits for a request whose response the test never reads to commit its consumption.
//!
//! A fixed sleep lost the race under load: the server had not committed yet, so the
//! "replay" was in fact the first use and was rightly accepted.

use std::{error::Error, time::Duration};

const CONSUMPTION_TIMEOUT: Duration = Duration::from_secs(10);
const CONSUMPTION_POLL: Duration = Duration::from_millis(20);

/// Waits until the Reference Service has committed the Gate Pass as consumed.
pub async fn wait_until_pass_consumed(
    database_url: &str,
    issuer: &str,
    pass_id: &str,
) -> Result<(), Box<dyn Error>> {
    wait_for_committed_row(
        database_url,
        "SELECT 1 FROM relying_service.pass_consumptions WHERE issuer = $1 AND pass_id = $2",
        &[issuer, pass_id],
    )
    .await
}

/// Waits until the Reference Service has committed the outcome-lookup proof as used.
pub async fn wait_until_outcome_proof_consumed(
    database_url: &str,
    proof_id: &str,
) -> Result<(), Box<dyn Error>> {
    wait_for_committed_row(
        database_url,
        "SELECT 1 FROM relying_service.claimant_outcome_proofs WHERE proof_id = $1",
        &[proof_id],
    )
    .await
}

async fn wait_for_committed_row(
    database_url: &str,
    sql: &str,
    binds: &[&str],
) -> Result<(), Box<dyn Error>> {
    let pool = sqlx::PgPool::connect(database_url).await?;
    let deadline = tokio::time::Instant::now() + CONSUMPTION_TIMEOUT;
    let result = loop {
        let query = binds
            .iter()
            .fold(sqlx::query(sql), |query, bind| query.bind(*bind));
        match query.fetch_optional(&pool).await {
            Ok(Some(_)) => break Ok(()),
            Ok(None) if tokio::time::Instant::now() >= deadline => {
                break Err(format!(
                    "no committed row for {binds:?} within {CONSUMPTION_TIMEOUT:?}"
                )
                .into());
            }
            Ok(None) => tokio::time::sleep(CONSUMPTION_POLL).await,
            Err(error) => break Err(error.into()),
        }
    };
    pool.close().await;
    result
}
