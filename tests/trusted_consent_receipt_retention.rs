use std::{error::Error, sync::Arc, time::Duration};

use bwg_core::authority::{self, AuthorityApplication};
use bwg_core::governance::{
    ApplyRetentionRequest, GovernanceApplication, GovernanceContext, RetentionPolicy,
};
use sqlx::PgPool;

#[path = "support/authority_keys.rs"]
mod authority_key_support;
#[path = "support/postgres.rs"]
mod postgres_support;
#[path = "support/running_server.rs"]
mod running_server_support;
#[path = "support/trusted_consent_authority.rs"]
mod trusted_consent_authority_support;
#[path = "support/trusted_consent_http.rs"]
mod trusted_consent_http_support;
#[path = "support/trusted_consent_verifier.rs"]
mod trusted_consent_verifier_support;
use postgres_support::PostgresTestDatabase;
use running_server_support::RunningServer;
use trusted_consent_authority_support::{authority_config, issue_elevated_challenge, offer_digest};
use trusted_consent_http_support::{begin_ceremony, finish_ceremony, finish_ceremony_response};
use trusted_consent_verifier_support::FakeVerifier;

#[tokio::test]
async fn expired_receipt_bytes_retire_and_cannot_be_reminted_after_restart()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let verifier = Arc::new(FakeVerifier::default());
    let application = AuthorityApplication::connect_postgres_with_trusted_consent_verifier(
        authority_config()?,
        database.database_url(),
        verifier.clone(),
    )
    .await?;
    let server = RunningServer::spawn(authority::router(application)).await?;
    let challenge = issue_elevated_challenge(&server.base_url).await?;
    let challenge_id = challenge["challenge_id"].as_str().ok_or("challenge ID")?;
    let ceremony =
        begin_ceremony(&server.base_url, challenge_id, &offer_digest(&challenge)?).await?;
    let ceremony_id = ceremony["ceremony_id"].as_str().ok_or("ceremony ID")?;
    let finished = finish_ceremony(&server.base_url, challenge_id, ceremony_id).await?;
    assert!(finished["trusted_consent_receipt"].is_string());
    let pool = PgPool::connect(database.database_url()).await?;
    let (created_at, verified_at) = sqlx::query_as::<_, (i64, i64)>(
        "SELECT created_at_unix_seconds, verified_at_unix_seconds
         FROM gate_authority.trusted_consent_ceremonies WHERE ceremony_id = $1",
    )
    .bind(ceremony_id)
    .fetch_one(&pool)
    .await?;
    let cutoff = created_at
        .max(verified_at)
        .checked_add(1)
        .ok_or("cutoff overflow")?;
    let mut transaction = pool.begin().await?;
    sqlx::query(
        "UPDATE gate_authority.trusted_consent_ceremonies
         SET expires_at_unix_seconds = $2,
             challenge_expires_at_unix_seconds = $2,
             receipt_expires_at_unix_seconds = $2
         WHERE ceremony_id = $1",
    )
    .bind(ceremony_id)
    .bind(cutoff)
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        "UPDATE gate_authority.work_challenges
         SET expires_at_unix_seconds = $2 WHERE challenge_id = $1",
    )
    .bind(challenge_id)
    .bind(cutoff)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    let now = std::time::SystemTime::UNIX_EPOCH.elapsed()?.as_secs();
    let wait_seconds = u64::try_from(cutoff)?.saturating_sub(now).saturating_add(1);
    tokio::time::sleep(Duration::from_secs(wait_seconds)).await;
    server.stop();

    // Act
    let policy = RetentionPolicy::hosted_default();
    let governance =
        GovernanceApplication::connect(GovernanceContext::GateAuthority, database.database_url())
            .await?;
    let manifest = governance
        .plan_retention(u64::try_from(cutoff)?, policy)
        .await?;
    let request = ApplyRetentionRequest::new(
        manifest.job_id(),
        manifest.manifest_digest(),
        100,
        true,
        true,
        policy,
        None,
    )?;
    governance.apply_retention(request).await?;
    let retained = sqlx::query_scalar::<_, Option<String>>(
        "SELECT trusted_consent_receipt
         FROM gate_authority.trusted_consent_ceremonies WHERE ceremony_id = $1",
    )
    .bind(ceremony_id)
    .fetch_one(&pool)
    .await?;
    let restarted = AuthorityApplication::connect_postgres_with_trusted_consent_verifier(
        authority_config()?,
        database.database_url(),
        verifier,
    )
    .await?;
    let restarted = RunningServer::spawn(authority::router(restarted)).await?;

    let response = finish_ceremony_response(&restarted.base_url, challenge_id, ceremony_id).await?;
    let repeated = finish_ceremony_response(&restarted.base_url, challenge_id, ceremony_id).await?;

    // Assert
    assert_eq!(response.status(), reqwest::StatusCode::GONE);
    assert_eq!(repeated.status(), reqwest::StatusCode::GONE);
    assert_eq!(retained, None);
    Ok(())
}
