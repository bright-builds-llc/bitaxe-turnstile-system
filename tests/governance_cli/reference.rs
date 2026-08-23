use std::{borrow::Cow, str::FromStr as _};

use super::*;

#[tokio::test]
async fn relying_migration_rejects_invalid_pass_and_terminal_times() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let bootstrap = run_reference(
        database.database_url(),
        &["plan-retention", "--as-of", "1"],
        false,
    )?;
    assert!(bootstrap.status.success());
    let pool = sqlx::PgPool::connect(database.database_url()).await?;
    sqlx::raw_sql(include_str!(
        "../fixtures/governance/insert_relying_retention_aggregate.sql"
    ))
    .execute(&pool)
    .await?;

    // Act
    let invalid_expiry = sqlx::query(include_str!(
        "../fixtures/governance/invalidate_pass_expiry.sql"
    ))
    .execute(&pool)
    .await;
    let invalid_terminal = sqlx::query(include_str!(
        "../fixtures/governance/invalidate_outcome_terminal.sql"
    ))
    .execute(&pool)
    .await;

    // Assert
    assert!(invalid_expiry.is_err());
    assert!(invalid_terminal.is_err());

    Ok(())
}

#[tokio::test]
async fn relying_migration_requires_safe_pass_expiry_backfill_before_legacy_planning()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let bootstrap_pool = sqlx::PgPool::connect(database.database_url()).await?;
    sqlx::query("CREATE SCHEMA relying_service")
        .execute(&bootstrap_pool)
        .await?;
    bootstrap_pool.close().await;
    let options = sqlx::postgres::PgConnectOptions::from_str(database.database_url())?
        .options([("search_path", "relying_service,public")]);
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await?;
    let full_migrator = sqlx::migrate!("./migrations/relying_service");
    let legacy_migrator = sqlx::migrate::Migrator {
        migrations: Cow::Owned(full_migrator.iter().take(5).cloned().collect()),
        ..sqlx::migrate::Migrator::DEFAULT
    };
    legacy_migrator.run(&pool).await?;
    sqlx::raw_sql(include_str!(
        "../fixtures/governance/insert_legacy_relying_rows.sql"
    ))
    .execute(&pool)
    .await?;
    let cutoff = (100 + 90 * 24 * 60 * 60).to_string();

    // Act
    let before_backfill = run_reference(
        database.database_url(),
        &["plan-retention", "--as-of", &cutoff],
        false,
    )?;
    sqlx::query(include_str!(
        "../fixtures/governance/backfill_legacy_pass_expiry.sql"
    ))
    .execute(&pool)
    .await?;
    let after_backfill = run_reference(
        database.database_url(),
        &["plan-retention", "--as-of", &cutoff],
        false,
    )?;
    let after_manifest = serde_json::from_slice::<Value>(&after_backfill.stdout)?;
    let apply = apply_reference_manifest(database.database_url(), &after_manifest)?;
    let remaining = run_reference(
        database.database_url(),
        &["plan-retention", "--as-of", &cutoff],
        false,
    )?;
    let before_backfill = serde_json::from_slice::<Value>(&before_backfill.stdout)?;
    let apply = serde_json::from_slice::<Value>(&apply.stdout)?;
    let remaining = serde_json::from_slice::<Value>(&remaining.stdout)?;

    // Assert
    assert_eq!(before_backfill["eligible_items"], 0);
    assert_eq!(after_manifest["eligible_items"], 1);
    assert_eq!(
        after_manifest["planned_counts"][0]["reason"],
        "overdue_retention_window_elapsed"
    );
    assert_eq!(apply["deleted_items"], 1);
    assert_eq!(remaining["eligible_items"], 0);

    Ok(())
}

#[tokio::test]
async fn relying_retention_respects_lookup_then_preserves_account_through_tombstone_deletion()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let bootstrap = run_reference(
        database.database_url(),
        &["plan-retention", "--as-of", "1"],
        false,
    )?;
    assert!(bootstrap.status.success());
    let pool = sqlx::PgPool::connect(database.database_url()).await?;
    sqlx::raw_sql(include_str!(
        "../fixtures/governance/insert_relying_retention_aggregate.sql"
    ))
    .execute(&pool)
    .await?;
    let day_30 = (100 + 30 * 24 * 60 * 60).to_string();
    let lookup_end = (100 + 35 * 24 * 60 * 60).to_string();
    let day_90 = (100 + 90 * 24 * 60 * 60).to_string();

    // Act
    let before_lookup_end = run_reference(
        database.database_url(),
        &["plan-retention", "--as-of", &day_30],
        false,
    )?;
    let before_lookup_manifest = serde_json::from_slice::<Value>(&before_lookup_end.stdout)?;
    let aggregate_plan = run_reference(
        database.database_url(),
        &["plan-retention", "--as-of", &lookup_end],
        false,
    )?;
    let aggregate_manifest = serde_json::from_slice::<Value>(&aggregate_plan.stdout)?;
    let missing_key = Command::new(env!("CARGO_BIN_EXE_reference-service-governance"))
        .args([
            "apply-retention",
            "--job-id",
            aggregate_manifest["job_id"]
                .as_str()
                .ok_or("plan should return a job ID")?,
            "--manifest-digest",
            aggregate_manifest["manifest_digest"]
                .as_str()
                .ok_or("plan should return a digest")?,
            "--confirm-destruction",
        ])
        .env("BWG_RELYING_SERVICE_DATABASE_URL", database.database_url())
        .env("BWG_GOVERNANCE_DESTRUCTIVE_ENABLED", "true")
        .env_remove("BWG_GOVERNANCE_PSEUDONYMIZATION_KEY")
        .output()?;
    let after_missing_key = run_reference(
        database.database_url(),
        &["plan-retention", "--as-of", &lookup_end],
        false,
    )?;
    let aggregate_apply = apply_reference_manifest(database.database_url(), &aggregate_manifest)?;
    let account_id = sqlx::query_scalar::<_, String>(include_str!(
        "../fixtures/governance/select_reference_account.sql"
    ))
    .fetch_one(&pool)
    .await?;
    let tombstone_plan = run_reference(
        database.database_url(),
        &["plan-retention", "--as-of", &day_90],
        false,
    )?;
    let tombstone_manifest = serde_json::from_slice::<Value>(&tombstone_plan.stdout)?;
    let tombstone_apply = apply_reference_manifest(database.database_url(), &tombstone_manifest)?;
    let remaining = run_reference(
        database.database_url(),
        &["plan-retention", "--as-of", &day_90],
        false,
    )?;
    let aggregate_apply = serde_json::from_slice::<Value>(&aggregate_apply.stdout)?;
    let after_missing_key = serde_json::from_slice::<Value>(&after_missing_key.stdout)?;
    let tombstone_apply = serde_json::from_slice::<Value>(&tombstone_apply.stdout)?;
    let remaining = serde_json::from_slice::<Value>(&remaining.stdout)?;

    // Assert
    assert_eq!(before_lookup_manifest["eligible_items"], 1);
    assert_eq!(
        before_lookup_manifest["planned_counts"][0]["record_class"],
        "pass_consumption"
    );
    assert_eq!(aggregate_manifest["eligible_items"], 1);
    assert_eq!(
        aggregate_manifest["planned_counts"][0]["action"],
        "pseudonymize"
    );
    assert!(!missing_key.status.success());
    assert_eq!(after_missing_key["eligible_items"], 1);
    assert_eq!(aggregate_apply["pseudonymized_items"], 1);
    assert_eq!(account_id, "account_retained");
    assert_eq!(tombstone_manifest["eligible_items"], 2);
    assert_eq!(tombstone_apply["deleted_items"], 2);
    assert_eq!(remaining["eligible_items"], 0);
    for output in [aggregate_apply, tombstone_apply] {
        assert!(!output.to_string().contains(TEST_PSEUDONYMIZATION_KEY));
        assert!(!output.to_string().contains("account_retained"));
        assert!(!output.to_string().contains("claimant_retention"));
    }

    Ok(())
}

#[tokio::test]
async fn overdue_pass_marker_deletes_directly_while_aggregate_lookup_remains_public()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let bootstrap = run_reference(
        database.database_url(),
        &["plan-retention", "--as-of", "1"],
        false,
    )?;
    assert!(bootstrap.status.success());
    let pool = sqlx::PgPool::connect(database.database_url()).await?;
    sqlx::raw_sql(include_str!(
        "../fixtures/governance/insert_relying_retention_aggregate.sql"
    ))
    .execute(&pool)
    .await?;
    let lookup_end = 100_u64 + 120 * 24 * 60 * 60;
    sqlx::query(include_str!(
        "../fixtures/governance/open_relying_public_lookup.sql"
    ))
    .bind("redemption_retention")
    .bind(i64::try_from(lookup_end)?)
    .execute(&pool)
    .await?;
    let marker_final_floor = (100 + 90 * 24 * 60 * 60).to_string();

    // Act
    let plan = run_reference(
        database.database_url(),
        &["plan-retention", "--as-of", &marker_final_floor],
        false,
    )?;
    let manifest = serde_json::from_slice::<Value>(&plan.stdout)?;
    let apply = apply_reference_manifest(database.database_url(), &manifest)?;
    let remaining = run_reference(
        database.database_url(),
        &["plan-retention", "--as-of", &marker_final_floor],
        false,
    )?;
    let apply = serde_json::from_slice::<Value>(&apply.stdout)?;
    let remaining = serde_json::from_slice::<Value>(&remaining.stdout)?;

    // Assert
    assert_eq!(manifest["eligible_items"], 1);
    assert_eq!(
        manifest["planned_counts"][0]["record_class"],
        "pass_consumption"
    );
    assert_eq!(
        manifest["planned_counts"][0]["reason"],
        "overdue_retention_window_elapsed"
    );
    assert_eq!(apply["deleted_items"], 1);
    assert_eq!(apply["pseudonymized_items"], 0);
    assert_eq!(remaining["eligible_items"], 0);

    Ok(())
}
