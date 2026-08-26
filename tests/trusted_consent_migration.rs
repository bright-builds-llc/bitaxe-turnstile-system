use std::{error::Error, fs, path::PathBuf, str::FromStr as _};

use bwg_core::authority::AuthorityApplication;
use sqlx::{
    PgPool,
    migrate::Migrator,
    postgres::{PgConnectOptions, PgPoolOptions},
};
use uuid::Uuid;

#[path = "support/authority_keys.rs"]
mod authority_key_support;
#[path = "support/postgres.rs"]
mod postgres_support;
#[path = "support/trusted_consent_authority.rs"]
mod trusted_consent_authority_support;
use postgres_support::PostgresTestDatabase;
use trusted_consent_authority_support::authority_config;

#[tokio::test]
async fn ticket_01_database_upgrades_additively_to_receipt_enforcement()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let bootstrap_pool = PgPool::connect(database.database_url()).await?;
    sqlx::query("CREATE SCHEMA IF NOT EXISTS gate_authority")
        .execute(&bootstrap_pool)
        .await?;
    bootstrap_pool.close().await;
    let connect_options = PgConnectOptions::from_str(database.database_url())?
        .options([("search_path", "gate_authority,public")]);
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect_with(connect_options)
        .await?;
    let migration_directory = copy_ticket_01_migrations()?;
    let ticket_01_migrator = Migrator::new(migration_directory.as_path()).await?;
    ticket_01_migrator.run(&pool).await?;
    seed_ticket_01_rows(&pool).await?;
    pool.close().await;

    // Act
    let _application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let verification_pool = PgPool::connect(database.database_url()).await?;
    let applied = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM gate_authority._sqlx_migrations
         WHERE version = 10 AND success = TRUE",
    )
    .fetch_one(&verification_pool)
    .await?;
    let receipt_columns = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM information_schema.columns
         WHERE table_schema = 'gate_authority'
           AND table_name = 'trusted_consent_ceremonies'
           AND column_name IN (
               'trusted_consent_receipt',
               'receipt_issued_at_unix_seconds',
               'receipt_expires_at_unix_seconds'
           )",
    )
    .fetch_one(&verification_pool)
    .await?;
    let requirements = sqlx::query_as::<_, (String, bool)>(
        "SELECT challenge_id, trusted_confirmation_required
         FROM gate_authority.work_challenges ORDER BY challenge_id",
    )
    .fetch_all(&verification_pool)
    .await?;
    let legacy_receipt = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT status, trusted_consent_receipt
         FROM gate_authority.trusted_consent_ceremonies
         WHERE ceremony_id = 'ceremony_upgrade_elevated'",
    )
    .fetch_one(&verification_pool)
    .await?;
    let session_links = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM gate_authority.work_sessions
         WHERE trusted_consent_ceremony_id IS NOT NULL",
    )
    .fetch_one(&verification_pool)
    .await?;
    sqlx::query(
        "UPDATE gate_authority.work_sessions
         SET trusted_consent_ceremony_id = 'ceremony_upgrade_elevated'
         WHERE session_id = 'session_upgrade_elevated'",
    )
    .execute(&verification_pool)
    .await?;
    let replayed_link = sqlx::query(
        "UPDATE gate_authority.work_sessions
         SET trusted_consent_ceremony_id = 'ceremony_upgrade_elevated'
         WHERE session_id = 'session_upgrade_standard'",
    )
    .execute(&verification_pool)
    .await;
    sqlx::query("DELETE FROM gate_authority.work_sessions")
        .execute(&verification_pool)
        .await?;
    sqlx::query(
        "DELETE FROM gate_authority.pool_selections
         WHERE challenge_id = 'challenge_upgrade_standard'",
    )
    .execute(&verification_pool)
    .await?;
    sqlx::query(
        "DELETE FROM gate_authority.work_challenges
         WHERE challenge_id = 'challenge_upgrade_standard'",
    )
    .execute(&verification_pool)
    .await?;
    let cascaded_ceremony = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM gate_authority.trusted_consent_ceremonies
         WHERE ceremony_id = 'ceremony_upgrade_standard'",
    )
    .fetch_one(&verification_pool)
    .await?;
    verification_pool.close().await;
    fs::remove_dir_all(&migration_directory)?;

    // Assert
    assert_eq!(applied, 1);
    assert_eq!(receipt_columns, 3);
    assert_eq!(
        requirements,
        vec![
            ("challenge_upgrade_elevated".to_owned(), true),
            ("challenge_upgrade_standard".to_owned(), false),
        ]
    );
    assert_eq!(legacy_receipt, ("verified".to_owned(), None));
    assert_eq!(session_links, 0);
    assert!(replayed_link.is_err());
    assert_eq!(cascaded_ceremony, 0);
    Ok(())
}

async fn seed_ticket_01_rows(pool: &PgPool) -> Result<(), Box<dyn Error>> {
    sqlx::raw_sql(
        "INSERT INTO gate_authority.work_challenges
           (challenge_id, descriptor, gate_pass_claims_seed, work_requirement,
            verified_progress, satisfied, expires_at_unix_seconds)
         VALUES
           ('challenge_upgrade_elevated',
            '{\"action_policy\":\"account-creation.elevated.v1\",\"pool_offers\":{}}'::jsonb,
            '{}'::jsonb, 1, 0, FALSE, 1000),
           ('challenge_upgrade_standard',
            '{\"action_policy\":\"account-creation.standard.v1\",\"pool_offers\":{}}'::jsonb,
            '{}'::jsonb, 1, 0, FALSE, 1000);

         INSERT INTO gate_authority.pool_selections
           (challenge_id, pool_offer_id, payout_commitment, status,
            selected_at_unix_seconds, consented_at_unix_seconds)
         VALUES
           ('challenge_upgrade_elevated', 'pool_upgrade', repeat('a', 64), 'consented', 100, 100),
           ('challenge_upgrade_standard', 'pool_upgrade', repeat('b', 64), 'consented', 100, 100);

         INSERT INTO gate_authority.work_sessions
           (session_id, challenge_id, pool_offer_id, payout_commitment)
         VALUES
           ('session_upgrade_elevated', 'challenge_upgrade_elevated',
            'pool_upgrade', repeat('a', 64)),
           ('session_upgrade_standard', 'challenge_upgrade_standard',
            'pool_upgrade', repeat('b', 64));

         INSERT INTO gate_authority.trusted_consent_ceremonies
           (ceremony_id, challenge_id, disclosure_digest_sha256,
            pool_offer_set_signature_sha256, reason, authority_origin,
            challenge_expires_at_unix_seconds, status, created_at_unix_seconds,
            expires_at_unix_seconds, verified_at_unix_seconds)
         VALUES
           ('ceremony_upgrade_elevated', 'challenge_upgrade_elevated', repeat('A', 43),
            repeat('B', 43), 'elevated_work', 'https://authority.example',
            1000, 'verified', 100, 200, 150),
           ('ceremony_upgrade_standard', 'challenge_upgrade_standard', repeat('C', 43),
            repeat('D', 43), 'material_pool_terms', 'https://authority.example',
            1000, 'verified', 100, 200, 150);",
    )
    .execute(pool)
    .await?;
    Ok(())
}

fn copy_ticket_01_migrations() -> Result<PathBuf, Box<dyn Error>> {
    let destination = std::env::temp_dir().join(format!(
        "bwg-ticket-01-migrations-{}",
        Uuid::new_v4().simple()
    ));
    fs::create_dir(&destination)?;
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("migrations/gate_authority");
    for name in [
        "0001_work_challenges.sql",
        "0002_accepted_work_and_issuance_intent.sql",
        "0003_claimant_issuance_proofs.sql",
        "0004_governance_jobs.sql",
        "0005_authority_retention.sql",
        "0006_governance_export.sql",
        "0007_challenge_and_session_lifecycle.sql",
        "0008_pool_offer_selection.sql",
        "0009_trusted_consent_ceremonies.sql",
    ] {
        fs::copy(source.join(name), destination.join(name))?;
    }
    Ok(destination)
}
