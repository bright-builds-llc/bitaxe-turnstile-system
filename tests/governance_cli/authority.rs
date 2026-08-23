use super::*;

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
    sqlx::query(
        "INSERT INTO gate_authority.work_challenges
         (challenge_id, descriptor, gate_pass_claims_seed, work_requirement,
          verified_progress, satisfied, expires_at_unix_seconds, terminal_at_unix_seconds)
         VALUES (
             'challenge_authority_retention', '{}'::jsonb, '{}'::jsonb,
             1, 1, TRUE, 100, 100
         )",
    )
    .execute(&pool)
    .await?;
    sqlx::query(
        "INSERT INTO gate_authority.gate_pass_issuance_intents
         (challenge_id, pass_id, algorithm, claims_template, signing_deadline_unix_seconds,
          status, authority_kid, gate_pass, issued_at_unix_seconds, expires_at_unix_seconds)
         VALUES (
             'challenge_authority_retention', 'pass_authority_retention', 'EdDSA', '{}'::jsonb,
             100, 'issued', 'authority-key', 'signed-gate-pass-secret', 100, 200
         )",
    )
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
async fn authority_legacy_rows_require_a_safe_terminal_backfill_before_planning()
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
    sqlx::query(
        "INSERT INTO gate_authority.work_challenges
         (challenge_id, descriptor, gate_pass_claims_seed, work_requirement,
          verified_progress, satisfied, expires_at_unix_seconds, terminal_at_unix_seconds)
         VALUES ('challenge_legacy_backfill', '{}'::jsonb, '{}'::jsonb, 1, 1, TRUE, 100, NULL)",
    )
    .execute(&pool)
    .await?;
    sqlx::query(
        "INSERT INTO gate_authority.gate_pass_issuance_intents
         (challenge_id, pass_id, algorithm, claims_template, signing_deadline_unix_seconds, status)
         VALUES (
             'challenge_legacy_backfill', 'pass_legacy_backfill', 'EdDSA', '{}'::jsonb, 100,
             'failed'
         )",
    )
    .execute(&pool)
    .await?;
    let cutoff = (100 + 30 * 24 * 60 * 60).to_string();

    // Act
    let before = run_authority(
        database.database_url(),
        &["plan-retention", "--as-of", &cutoff],
        false,
    )?;
    sqlx::query(
        "UPDATE gate_authority.work_challenges
         SET terminal_at_unix_seconds = 100
         WHERE challenge_id = 'challenge_legacy_backfill'",
    )
    .execute(&pool)
    .await?;
    let after = run_authority(
        database.database_url(),
        &["plan-retention", "--as-of", &cutoff],
        false,
    )?;
    let before = serde_json::from_slice::<Value>(&before.stdout)?;
    let after = serde_json::from_slice::<Value>(&after.stdout)?;

    // Assert
    assert_eq!(before["eligible_items"], 0);
    assert_eq!(after["eligible_items"], 1);
    assert_eq!(
        after["planned_counts"][0]["record_class"],
        "authority_operational"
    );

    Ok(())
}
