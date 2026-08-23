use std::{borrow::Cow, str::FromStr as _};

use super::*;

#[tokio::test]
async fn authority_migration_rejects_invalid_terminal_and_retirement_times()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let bootstrap = run_authority(
        database.database_url(),
        &["plan-retention", "--as-of", "1"],
        false,
    )?;
    assert!(bootstrap.status.success());
    let pool = sqlx::PgPool::connect(database.database_url()).await?;

    // Act
    let invalid_terminal = sqlx::query(include_str!(
        "../fixtures/governance/insert_invalid_terminal_challenge.sql"
    ))
    .execute(&pool)
    .await;
    sqlx::query(include_str!(
        "../fixtures/governance/insert_authority_retention_challenge.sql"
    ))
    .execute(&pool)
    .await?;
    let early_retirement = sqlx::query(include_str!(
        "../fixtures/governance/insert_early_retired_pass.sql"
    ))
    .execute(&pool)
    .await;

    // Assert
    assert!(invalid_terminal.is_err());
    assert!(early_retirement.is_err());

    Ok(())
}

#[tokio::test]
async fn authority_retention_stages_pass_erasure_pseudonymization_and_tombstone_deletion()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let bootstrap = run_authority(
        database.database_url(),
        &["plan-retention", "--as-of", "1"],
        false,
    )?;
    assert!(bootstrap.status.success());
    let pool = sqlx::PgPool::connect(database.database_url()).await?;
    sqlx::query(include_str!(
        "../fixtures/governance/insert_authority_retention_challenge.sql"
    ))
    .execute(&pool)
    .await?;
    sqlx::query(include_str!(
        "../fixtures/governance/insert_authority_retention_intent.sql"
    ))
    .execute(&pool)
    .await?;
    sqlx::raw_sql(include_str!(
        "../fixtures/governance/insert_authority_retention_children.sql"
    ))
    .execute(&pool)
    .await?;

    // Act
    let pass_plan = run_authority(
        database.database_url(),
        &["plan-retention", "--as-of", "200"],
        false,
    )?;
    let pass_manifest = serde_json::from_slice::<Value>(&pass_plan.stdout)?;
    let pass_apply = apply_authority_manifest(database.database_url(), &pass_manifest)?;
    let after_pass = run_authority(
        database.database_url(),
        &["plan-retention", "--as-of", "200"],
        false,
    )?;
    sqlx::query(include_str!(
        "../fixtures/governance/insert_authority_retention_proof.sql"
    ))
    .execute(&pool)
    .await?;
    let operational_cutoff = (100 + 30 * 24 * 60 * 60).to_string();
    let operational_plan = run_authority(
        database.database_url(),
        &["plan-retention", "--as-of", &operational_cutoff],
        false,
    )?;
    let operational_manifest = serde_json::from_slice::<Value>(&operational_plan.stdout)?;
    let missing_key = Command::new(env!("CARGO_BIN_EXE_gate-authority-governance"))
        .args([
            "apply-retention",
            "--job-id",
            operational_manifest["job_id"]
                .as_str()
                .ok_or("plan should return a job ID")?,
            "--manifest-digest",
            operational_manifest["manifest_digest"]
                .as_str()
                .ok_or("plan should return a digest")?,
            "--confirm-destruction",
        ])
        .env("BWG_AUTHORITY_DATABASE_URL", database.database_url())
        .env("BWG_GOVERNANCE_DESTRUCTIVE_ENABLED", "true")
        .env_remove("BWG_GOVERNANCE_PSEUDONYMIZATION_KEY")
        .output()?;
    let after_missing_key = run_authority(
        database.database_url(),
        &["plan-retention", "--as-of", &operational_cutoff],
        false,
    )?;
    let operational_apply =
        apply_authority_manifest(database.database_url(), &operational_manifest)?;
    let tombstone_cutoff = (100 + 90 * 24 * 60 * 60).to_string();
    let tombstone_plan = run_authority(
        database.database_url(),
        &["plan-retention", "--as-of", &tombstone_cutoff],
        false,
    )?;
    let tombstone_manifest = serde_json::from_slice::<Value>(&tombstone_plan.stdout)?;
    let tombstone_apply = apply_authority_manifest(database.database_url(), &tombstone_manifest)?;
    let remaining = run_authority(
        database.database_url(),
        &["plan-retention", "--as-of", &tombstone_cutoff],
        false,
    )?;
    let pass_apply = serde_json::from_slice::<Value>(&pass_apply.stdout)?;
    let after_pass = serde_json::from_slice::<Value>(&after_pass.stdout)?;
    let operational_apply = serde_json::from_slice::<Value>(&operational_apply.stdout)?;
    let after_missing_key = serde_json::from_slice::<Value>(&after_missing_key.stdout)?;
    let tombstone_apply = serde_json::from_slice::<Value>(&tombstone_apply.stdout)?;
    let remaining = serde_json::from_slice::<Value>(&remaining.stdout)?;

    // Assert
    assert_eq!(
        pass_manifest["planned_counts"][0]["record_class"],
        "signed_gate_pass"
    );
    assert_eq!(pass_apply["deleted_items"], 1);
    assert_eq!(after_pass["eligible_items"], 0);
    assert_eq!(
        operational_manifest["planned_counts"][0]["action"],
        "pseudonymize"
    );
    assert_eq!(operational_manifest["eligible_items"], 1);
    assert!(!missing_key.status.success());
    assert_eq!(after_missing_key["eligible_items"], 1);
    assert_eq!(operational_apply["pseudonymized_items"], 1);
    assert_eq!(tombstone_manifest["planned_counts"][0]["action"], "delete");
    assert_eq!(tombstone_apply["deleted_items"], 1);
    assert_eq!(remaining["eligible_items"], 0);
    for output in [pass_apply, operational_apply, tombstone_apply] {
        assert!(!output.to_string().contains(TEST_PSEUDONYMIZATION_KEY));
        assert!(!output.to_string().contains("signed-gate-pass-secret"));
    }

    Ok(())
}

#[tokio::test]
async fn authority_migration_backfills_a_safe_terminal_before_legacy_rows_are_planned()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let bootstrap_pool = sqlx::PgPool::connect(database.database_url()).await?;
    sqlx::query("CREATE SCHEMA gate_authority")
        .execute(&bootstrap_pool)
        .await?;
    bootstrap_pool.close().await;
    let options = sqlx::postgres::PgConnectOptions::from_str(database.database_url())?
        .options([("search_path", "gate_authority,public")]);
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await?;
    let full_migrator = sqlx::migrate!("./migrations/gate_authority");
    let legacy_migrator = sqlx::migrate::Migrator {
        migrations: Cow::Owned(full_migrator.iter().take(4).cloned().collect()),
        ..sqlx::migrate::Migrator::DEFAULT
    };
    legacy_migrator.run(&pool).await?;
    sqlx::raw_sql(include_str!(
        "../fixtures/governance/insert_legacy_authority_rows.sql"
    ))
    .execute(&pool)
    .await?;
    let cutoff = (100 + 30 * 24 * 60 * 60).to_string();

    // Act
    let after = run_authority(
        database.database_url(),
        &["plan-retention", "--as-of", &cutoff],
        false,
    )?;
    if !after.status.success() {
        return Err(String::from_utf8_lossy(&after.stderr).into_owned().into());
    }
    let after = serde_json::from_slice::<Value>(&after.stdout)?;

    // Assert
    assert_eq!(after["eligible_items"], 1);
    assert_eq!(
        after["planned_counts"][0]["record_class"],
        "authority_operational"
    );

    Ok(())
}
