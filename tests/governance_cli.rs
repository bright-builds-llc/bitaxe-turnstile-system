use std::{error::Error, process::Command};

use serde_json::Value;

#[path = "governance_cli/authority.rs"]
mod authority;
#[path = "support/postgres.rs"]
mod postgres_support;
#[path = "governance_cli/reference.rs"]
mod reference;

use postgres_support::PostgresTestDatabase;

const TEST_PSEUDONYMIZATION_KEY: &str = "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A";

#[test]
fn both_service_local_clis_publish_the_governance_command_surface() -> Result<(), Box<dyn Error>> {
    // Arrange
    let binaries = [
        env!("CARGO_BIN_EXE_gate-authority-governance"),
        env!("CARGO_BIN_EXE_reference-service-governance"),
    ];

    for binary in binaries {
        // Act
        let output = Command::new(binary).arg("--help").output()?;
        let stdout = String::from_utf8(output.stdout)?;

        // Assert
        assert!(output.status.success());
        assert!(stdout.contains("plan-retention"));
        assert!(stdout.contains("apply-retention"));
        assert!(stdout.contains("export"));
    }

    Ok(())
}

#[tokio::test]
async fn authority_plan_persists_a_digest_bound_dry_run_without_domain_changes()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;

    // Act
    let output = Command::new(env!("CARGO_BIN_EXE_gate-authority-governance"))
        .args(["plan-retention", "--as-of", "100"])
        .env("BWG_AUTHORITY_DATABASE_URL", database.database_url())
        .output()?;
    let manifest = serde_json::from_slice::<Value>(&output.stdout)?;
    let future = Command::new(env!("CARGO_BIN_EXE_gate-authority-governance"))
        .args(["plan-retention", "--as-of", &u64::MAX.to_string()])
        .env("BWG_AUTHORITY_DATABASE_URL", database.database_url())
        .output()?;

    // Assert
    assert!(output.status.success());
    assert_eq!(manifest["context"], "gate_authority");
    assert_eq!(manifest["status"], "planned");
    assert_eq!(manifest["eligible_items"], 0);
    assert_eq!(
        manifest["manifest_digest"]
            .as_str()
            .ok_or("manifest digest should be a string")?
            .len(),
        64
    );
    assert!(!future.status.success());

    Ok(())
}

#[tokio::test]
async fn authority_apply_requires_the_exact_manifest_and_is_idempotent()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let initial_plan = run_authority(
        database.database_url(),
        &["plan-retention", "--as-of", "100"],
        false,
    )?;
    assert!(initial_plan.status.success());
    let pool = sqlx::PgPool::connect(database.database_url()).await?;
    sqlx::query(
        "INSERT INTO gate_authority.work_challenges
         (challenge_id, descriptor, gate_pass_claims_seed, work_requirement,
          verified_progress, satisfied, expires_at_unix_seconds)
         VALUES ('challenge_governance_fixture', '{}'::jsonb, '{}'::jsonb, 1, 0, FALSE, 200)",
    )
    .execute(&pool)
    .await?;
    sqlx::query(
        "INSERT INTO gate_authority.claimant_issuance_proofs
         (proof_id, challenge_id, expires_at_unix_seconds)
         VALUES ('proof_governance_fixture', 'challenge_governance_fixture', 50)",
    )
    .execute(&pool)
    .await?;
    let planned = run_authority(
        database.database_url(),
        &["plan-retention", "--as-of", "100"],
        false,
    )?;
    let manifest = serde_json::from_slice::<Value>(&planned.stdout)?;
    let job_id = manifest["job_id"]
        .as_str()
        .ok_or("plan should return a job ID")?;
    let digest = manifest["manifest_digest"]
        .as_str()
        .ok_or("plan should return a digest")?;
    assert_eq!(
        manifest["planned_counts"][0]["record_class"],
        "claimant_issuance_proof_replay"
    );
    assert_eq!(manifest["planned_counts"][0]["action"], "delete");
    assert_eq!(
        manifest["planned_counts"][0]["reason"],
        "protocol_retention_floor_reached"
    );
    assert_eq!(manifest["planned_counts"][0]["count"], 1);
    let reference_bootstrap = run_reference(
        database.database_url(),
        &["plan-retention", "--as-of", "100"],
        false,
    )?;
    assert!(reference_bootstrap.status.success());

    // Act
    let disabled = run_authority(
        database.database_url(),
        &[
            "apply-retention",
            "--job-id",
            job_id,
            "--manifest-digest",
            digest,
            "--confirm-destruction",
        ],
        false,
    )?;
    let unconfirmed = run_authority(
        database.database_url(),
        &[
            "apply-retention",
            "--job-id",
            job_id,
            "--manifest-digest",
            digest,
        ],
        true,
    )?;
    let rejected = run_authority(
        database.database_url(),
        &[
            "apply-retention",
            "--job-id",
            job_id,
            "--manifest-digest",
            &"0".repeat(64),
            "--batch-size",
            "1",
            "--confirm-destruction",
        ],
        true,
    )?;
    let stale_policy = run_authority(
        database.database_url(),
        &[
            "apply-retention",
            "--job-id",
            job_id,
            "--manifest-digest",
            digest,
            "--operational-retention-seconds",
            "2678400",
            "--confirm-destruction",
        ],
        true,
    )?;
    let wrong_context = run_reference(
        database.database_url(),
        &[
            "apply-retention",
            "--job-id",
            job_id,
            "--manifest-digest",
            digest,
            "--confirm-destruction",
        ],
        true,
    )?;
    sqlx::query(
        "UPDATE gate_authority.claimant_issuance_proofs
         SET expires_at_unix_seconds = 60
         WHERE proof_id = 'proof_governance_fixture'",
    )
    .execute(&pool)
    .await?;
    let stale_record = run_authority(
        database.database_url(),
        &[
            "apply-retention",
            "--job-id",
            job_id,
            "--manifest-digest",
            digest,
            "--confirm-destruction",
        ],
        true,
    )?;
    sqlx::query(
        "UPDATE gate_authority.claimant_issuance_proofs
         SET expires_at_unix_seconds = 50
         WHERE proof_id = 'proof_governance_fixture'",
    )
    .execute(&pool)
    .await?;
    sqlx::query(
        "UPDATE gate_authority.governance_retention_items
         SET eligibility_reason = 'tombstone_window_elapsed'
         WHERE job_id = $1::uuid",
    )
    .bind(job_id)
    .execute(&pool)
    .await?;
    let changed_manifest_item = run_authority(
        database.database_url(),
        &[
            "apply-retention",
            "--job-id",
            job_id,
            "--manifest-digest",
            digest,
            "--confirm-destruction",
        ],
        true,
    )?;
    sqlx::query(
        "UPDATE gate_authority.governance_retention_items
         SET eligibility_reason = 'protocol_retention_floor_reached'
         WHERE job_id = $1::uuid",
    )
    .bind(job_id)
    .execute(&pool)
    .await?;
    let applied = run_authority(
        database.database_url(),
        &[
            "apply-retention",
            "--job-id",
            job_id,
            "--manifest-digest",
            digest,
            "--batch-size",
            "1",
            "--confirm-destruction",
        ],
        true,
    )?;
    let repeated = run_authority(
        database.database_url(),
        &[
            "apply-retention",
            "--job-id",
            job_id,
            "--manifest-digest",
            digest,
            "--batch-size",
            "1",
            "--confirm-destruction",
        ],
        true,
    )?;
    let remaining = run_authority(
        database.database_url(),
        &["plan-retention", "--as-of", "100"],
        false,
    )?;
    let applied = serde_json::from_slice::<Value>(&applied.stdout)?;
    let repeated = serde_json::from_slice::<Value>(&repeated.stdout)?;
    let remaining = serde_json::from_slice::<Value>(&remaining.stdout)?;

    // Assert
    assert!(!disabled.status.success());
    assert!(!unconfirmed.status.success());
    assert!(!rejected.status.success());
    assert!(!stale_policy.status.success());
    assert!(!wrong_context.status.success());
    assert!(!stale_record.status.success());
    assert!(!changed_manifest_item.status.success());
    assert_eq!(applied["status"], "completed");
    assert_eq!(applied["deleted_items"], 1);
    assert_eq!(repeated["status"], "completed");
    assert_eq!(repeated["deleted_items"], 0);
    assert_eq!(remaining["eligible_items"], 0);

    Ok(())
}

#[tokio::test]
async fn relying_service_batches_stay_independent_from_authority_governance()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let initial = run_reference(
        database.database_url(),
        &["plan-retention", "--as-of", "100"],
        false,
    )?;
    assert!(initial.status.success());
    let pool = sqlx::PgPool::connect(database.database_url()).await?;
    sqlx::query(
        "INSERT INTO relying_service.dpop_proofs (proof_id, expires_at_unix_seconds)
         VALUES ('dpop_governance_fixture', 40)",
    )
    .execute(&pool)
    .await?;
    sqlx::query(
        "INSERT INTO relying_service.claimant_outcome_proofs
         (proof_id, expires_at_unix_seconds)
         VALUES ('outcome_governance_fixture', 50)",
    )
    .execute(&pool)
    .await?;
    let planned = run_reference(
        database.database_url(),
        &["plan-retention", "--as-of", "100"],
        false,
    )?;
    let manifest = serde_json::from_slice::<Value>(&planned.stdout)?;
    let job_id = manifest["job_id"]
        .as_str()
        .ok_or("plan should return a job ID")?;
    let digest = manifest["manifest_digest"]
        .as_str()
        .ok_or("plan should return a digest")?;

    // Act
    let first_batch = run_reference(
        database.database_url(),
        &[
            "apply-retention",
            "--job-id",
            job_id,
            "--manifest-digest",
            digest,
            "--batch-size",
            "1",
            "--confirm-destruction",
        ],
        true,
    )?;
    let authority_plan = run_authority(
        database.database_url(),
        &["plan-retention", "--as-of", "100"],
        false,
    )?;
    let second_batch = run_reference(
        database.database_url(),
        &[
            "apply-retention",
            "--job-id",
            job_id,
            "--manifest-digest",
            digest,
            "--batch-size",
            "1",
            "--confirm-destruction",
        ],
        true,
    )?;
    let remaining = run_reference(
        database.database_url(),
        &["plan-retention", "--as-of", "100"],
        false,
    )?;
    let first_batch = serde_json::from_slice::<Value>(&first_batch.stdout)?;
    let authority_plan = serde_json::from_slice::<Value>(&authority_plan.stdout)?;
    let second_batch = serde_json::from_slice::<Value>(&second_batch.stdout)?;
    let remaining = serde_json::from_slice::<Value>(&remaining.stdout)?;

    // Assert
    assert_eq!(manifest["eligible_items"], 2);
    assert_eq!(first_batch["status"], "applying");
    assert_eq!(first_batch["deleted_items"], 1);
    assert_eq!(authority_plan["eligible_items"], 0);
    assert_eq!(second_batch["status"], "completed");
    assert_eq!(second_batch["deleted_items"], 1);
    assert_eq!(remaining["eligible_items"], 0);

    Ok(())
}

fn run_authority(
    database_url: &str,
    arguments: &[&str],
    destructive_enabled: bool,
) -> Result<std::process::Output, Box<dyn Error>> {
    Ok(
        Command::new(env!("CARGO_BIN_EXE_gate-authority-governance"))
            .args(arguments)
            .env("BWG_AUTHORITY_DATABASE_URL", database_url)
            .env(
                "BWG_GOVERNANCE_DESTRUCTIVE_ENABLED",
                destructive_enabled.to_string(),
            )
            .env(
                "BWG_GOVERNANCE_PSEUDONYMIZATION_KEY",
                TEST_PSEUDONYMIZATION_KEY,
            )
            .output()?,
    )
}

fn run_reference(
    database_url: &str,
    arguments: &[&str],
    destructive_enabled: bool,
) -> Result<std::process::Output, Box<dyn Error>> {
    Ok(
        Command::new(env!("CARGO_BIN_EXE_reference-service-governance"))
            .args(arguments)
            .env("BWG_RELYING_SERVICE_DATABASE_URL", database_url)
            .env(
                "BWG_GOVERNANCE_DESTRUCTIVE_ENABLED",
                destructive_enabled.to_string(),
            )
            .env(
                "BWG_GOVERNANCE_PSEUDONYMIZATION_KEY",
                TEST_PSEUDONYMIZATION_KEY,
            )
            .output()?,
    )
}

fn apply_reference_manifest(
    database_url: &str,
    manifest: &Value,
) -> Result<std::process::Output, Box<dyn Error>> {
    let job_id = manifest["job_id"]
        .as_str()
        .ok_or("plan should return a job ID")?;
    let digest = manifest["manifest_digest"]
        .as_str()
        .ok_or("plan should return a digest")?;
    run_reference(
        database_url,
        &[
            "apply-retention",
            "--job-id",
            job_id,
            "--manifest-digest",
            digest,
            "--confirm-destruction",
        ],
        true,
    )
}

fn apply_authority_manifest(
    database_url: &str,
    manifest: &Value,
) -> Result<std::process::Output, Box<dyn Error>> {
    let job_id = manifest["job_id"]
        .as_str()
        .ok_or("plan should return a job ID")?;
    let digest = manifest["manifest_digest"]
        .as_str()
        .ok_or("plan should return a digest")?;
    run_authority(
        database_url,
        &[
            "apply-retention",
            "--job-id",
            job_id,
            "--manifest-digest",
            digest,
            "--confirm-destruction",
        ],
        true,
    )
}
