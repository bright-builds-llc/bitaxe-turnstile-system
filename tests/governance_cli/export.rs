use ring::digest::{SHA256, digest};

use super::*;

#[tokio::test]
async fn export_migration_rejects_invalid_digest_and_lifecycle_states() -> Result<(), Box<dyn Error>>
{
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
    let invalid_digest = sqlx::query(include_str!(
        "../fixtures/governance/insert_invalid_export_digest.sql"
    ))
    .execute(&pool)
    .await;
    let invalid_lifecycle = sqlx::query(include_str!(
        "../fixtures/governance/insert_invalid_completed_export.sql"
    ))
    .execute(&pool)
    .await;

    // Assert
    assert!(invalid_digest.is_err());
    assert!(invalid_lifecycle.is_err());

    Ok(())
}

#[tokio::test]
async fn authority_export_resumes_the_same_redacted_snapshot_with_an_integrity_manifest()
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

    // Act
    let first_page = run_authority(
        database.database_url(),
        &["export", "--snapshot-cutoff", "1000", "--page-size", "1"],
        false,
    )?;
    let first_lines = ndjson_lines(&first_page.stdout)?;
    let export_id = first_lines[0]["export_id"]
        .as_str()
        .ok_or("export envelope needs an export ID")?;
    sqlx::query(include_str!(
        "../fixtures/governance/insert_post_snapshot_authority_challenge.sql"
    ))
    .execute(&pool)
    .await?;
    let resumed = run_authority(
        database.database_url(),
        &[
            "export",
            "--export-id",
            export_id,
            "--after-sequence",
            "1",
            "--page-size",
            "100",
        ],
        false,
    )?;
    let repeated = run_authority(
        database.database_url(),
        &[
            "export",
            "--export-id",
            export_id,
            "--after-sequence",
            "1",
            "--page-size",
            "100",
        ],
        false,
    )?;
    let resumed_lines = ndjson_lines(&resumed.stdout)?;
    let manifest = resumed_lines
        .last()
        .ok_or("completed export needs a manifest")?;
    let mut data_bytes = first_page.stdout.clone();
    let manifest_line = serde_json::to_vec(manifest)?;
    let resumed_data_length = resumed.stdout.len() - manifest_line.len() - 1;
    data_bytes.extend_from_slice(&resumed.stdout[..resumed_data_length]);
    let expected_digest = hex_digest(&data_bytes);
    let all_output = [first_page.stdout.clone(), resumed.stdout.clone()].concat();
    let all_output = String::from_utf8(all_output)?;

    // Assert
    assert!(first_page.status.success());
    assert!(resumed.status.success());
    assert_eq!(resumed.stdout, repeated.stdout);
    assert_eq!(manifest["record_type"], "governance_manifest");
    assert_eq!(manifest["payload"]["content_sha256"], expected_digest);
    assert_eq!(manifest["payload"]["total_bytes"], data_bytes.len());
    assert_eq!(
        manifest["payload"]["total_items"],
        first_lines.len() + resumed_lines.len() - 1
    );
    assert!(!all_output.contains("signed-gate-pass-secret"));
    assert!(!all_output.contains("post-snapshot-secret"));
    assert!(!all_output.contains(TEST_PSEUDONYMIZATION_KEY));

    Ok(())
}

#[tokio::test]
async fn relying_export_excludes_claimant_action_and_account_identity_bytes()
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

    // Act
    let export = run_reference(
        database.database_url(),
        &["export", "--snapshot-cutoff", "1000", "--page-size", "100"],
        false,
    )?;
    let lines = ndjson_lines(&export.stdout)?;
    let record_types = lines
        .iter()
        .map(|line| line["record_type"].as_str().unwrap_or_default())
        .collect::<Vec<_>>();
    let output = String::from_utf8(export.stdout)?;

    // Assert
    assert!(export.status.success());
    assert!(record_types.contains(&"redemption_outcome_summary"));
    assert!(record_types.contains(&"pass_consumption_summary"));
    assert_eq!(record_types.last(), Some(&"governance_manifest"));
    for prohibited in [
        "claimant_retention",
        "action_reference_retention",
        "account_retained",
        "pass_retention",
        "https://authority.example",
        TEST_PSEUDONYMIZATION_KEY,
    ] {
        assert!(!output.contains(prohibited));
    }

    Ok(())
}

fn ndjson_lines(bytes: &[u8]) -> Result<Vec<Value>, Box<dyn Error>> {
    String::from_utf8(bytes.to_vec())?
        .lines()
        .map(|line| serde_json::from_str(line).map_err(Into::into))
        .collect()
}

fn hex_digest(bytes: &[u8]) -> String {
    digest(&SHA256, bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
