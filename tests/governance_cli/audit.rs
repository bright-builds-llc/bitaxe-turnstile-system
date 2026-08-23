use std::time::{SystemTime, UNIX_EPOCH};

use super::*;

#[tokio::test]
async fn governance_audit_records_safe_success_failure_and_ninety_day_deletion()
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
        "../fixtures/governance/insert_old_governance_audit.sql"
    ))
    .execute(&pool)
    .await?;
    let audit_floor = (100 + 90 * 24 * 60 * 60).to_string();
    let plan = run_authority(
        database.database_url(),
        &["plan-retention", "--as-of", &audit_floor],
        false,
    )?;
    let manifest = serde_json::from_slice::<Value>(&plan.stdout)?;

    // Act
    let failed_apply = run_authority(
        database.database_url(),
        &[
            "apply-retention",
            "--job-id",
            manifest["job_id"].as_str().ok_or("plan needs a job ID")?,
            "--manifest-digest",
            &"0".repeat(64),
            "--confirm-destruction",
        ],
        true,
    )?;
    let applied = apply_authority_manifest(database.database_url(), &manifest)?;
    let failed_export = run_authority(
        database.database_url(),
        &[
            "export",
            "--export-id",
            "00000000-0000-4000-8000-000000000099",
            "--after-sequence",
            "0",
        ],
        false,
    )?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let audit_export = run_authority(
        database.database_url(),
        &[
            "export",
            "--snapshot-cutoff",
            &now.to_string(),
            "--page-size",
            "1",
        ],
        false,
    )?;
    let audit_lines = String::from_utf8(audit_export.stdout.clone())?;
    let export_id = serde_json::from_str::<Value>(
        audit_lines
            .lines()
            .next()
            .ok_or("audit export needs a record")?,
    )?["export_id"]
        .as_str()
        .ok_or("audit export needs an ID")?
        .to_owned();
    let audit_resume = run_authority(
        database.database_url(),
        &[
            "export",
            "--export-id",
            &export_id,
            "--after-sequence",
            "1",
            "--page-size",
            "1000",
        ],
        false,
    )?;
    assert!(audit_resume.status.success());
    let inspection_cutoff = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let audit_inspection = run_authority(
        database.database_url(),
        &[
            "export",
            "--snapshot-cutoff",
            &inspection_cutoff.to_string(),
            "--page-size",
            "1000",
        ],
        false,
    )?;
    sqlx::query(include_str!(
        "../fixtures/governance/age_export_snapshot.sql"
    ))
    .bind(&export_id)
    .execute(&pool)
    .await?;
    let snapshot_plan = run_authority(
        database.database_url(),
        &["plan-retention", "--as-of", &audit_floor],
        false,
    )?;
    let snapshot_manifest = serde_json::from_slice::<Value>(&snapshot_plan.stdout)?;
    let snapshot_apply = apply_authority_manifest(database.database_url(), &snapshot_manifest)?;
    let remaining = run_authority(
        database.database_url(),
        &["plan-retention", "--as-of", &audit_floor],
        false,
    )?;
    let audit_output = String::from_utf8(audit_inspection.stdout)?;
    let applied = serde_json::from_slice::<Value>(&applied.stdout)?;
    let snapshot_apply = serde_json::from_slice::<Value>(&snapshot_apply.stdout)?;
    let remaining = serde_json::from_slice::<Value>(&remaining.stdout)?;

    // Assert
    assert_eq!(
        manifest["planned_counts"][0]["record_class"],
        "governance_audit"
    );
    assert!(!failed_apply.status.success());
    assert_eq!(applied["deleted_items"], 1);
    assert!(!failed_export.status.success());
    for event_type in [
        "retention_planned",
        "retention_applied",
        "retention_failed",
        "deleted",
        "export_started",
        "export_completed",
        "export_failed",
        "recovery_resumed",
    ] {
        assert!(audit_output.contains(event_type));
    }
    assert!(!audit_output.contains("00000000-0000-4000-8000-000000000091"));
    assert!(!audit_output.contains(TEST_PSEUDONYMIZATION_KEY));
    assert!(audit_output.contains("\"context\":\"gate_authority\""));
    assert!(audit_output.contains("snapshot_cutoff_unix_seconds"));
    assert_eq!(
        snapshot_manifest["planned_counts"][0]["record_class"],
        "governance_export_snapshot"
    );
    assert_eq!(snapshot_apply["deleted_items"], 1);
    assert_eq!(remaining["eligible_items"], 0);

    Ok(())
}
