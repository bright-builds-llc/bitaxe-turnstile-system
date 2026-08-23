use std::{error::Error, process::Command};

use serde_json::Value;

#[path = "support/postgres.rs"]
mod postgres_support;

use postgres_support::PostgresTestDatabase;

const PSEUDONYMIZATION_KEY: &str = "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A";

enum GovernanceRole {
    Authority,
    RelyingService,
}

enum KeyAccess {
    Available,
    Missing,
}

struct ManifestArguments {
    job_id: String,
    manifest_digest: String,
}

#[tokio::test]
async fn independent_context_failure_recovery_and_export_converge_in_one_cluster()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    assert!(
        run_authority(database.database_url(), &["plan-retention", "--as-of", "1"])?
            .status
            .success()
    );
    assert!(
        run_reference(database.database_url(), &["plan-retention", "--as-of", "1"])?
            .status
            .success()
    );
    let pool = sqlx::PgPool::connect(database.database_url()).await?;
    sqlx::query(include_str!(
        "fixtures/governance/insert_authority_retention_challenge.sql"
    ))
    .execute(&pool)
    .await?;
    sqlx::query(include_str!(
        "fixtures/governance/insert_authority_retention_intent.sql"
    ))
    .execute(&pool)
    .await?;
    sqlx::raw_sql(include_str!(
        "fixtures/governance/insert_authority_retention_children.sql"
    ))
    .execute(&pool)
    .await?;
    sqlx::raw_sql(include_str!(
        "fixtures/governance/insert_relying_retention_aggregate.sql"
    ))
    .execute(&pool)
    .await?;
    let authority_cutoff = (100 + 30 * 24 * 60 * 60).to_string();
    let reference_cutoff = (100 + 35 * 24 * 60 * 60).to_string();
    let authority_plan = run_authority(
        database.database_url(),
        &["plan-retention", "--as-of", &authority_cutoff],
    )?;
    let reference_plan = run_reference(
        database.database_url(),
        &["plan-retention", "--as-of", &reference_cutoff],
    )?;
    let authority_manifest = serde_json::from_slice::<Value>(&authority_plan.stdout)?;
    let reference_manifest = serde_json::from_slice::<Value>(&reference_plan.stdout)?;

    // Act
    let database_url = database.database_url().to_owned();
    let authority_job = manifest_arguments(&authority_manifest)?;
    let reference_job = manifest_arguments(&reference_manifest)?;
    let (authority_failed, reference_applied) = std::thread::scope(|scope| {
        let authority = scope.spawn(|| {
            run_apply(
                &database_url,
                GovernanceRole::Authority,
                &authority_job,
                KeyAccess::Missing,
            )
        });
        let reference = scope.spawn(|| {
            run_apply(
                &database_url,
                GovernanceRole::RelyingService,
                &reference_job,
                KeyAccess::Available,
            )
        });
        (authority.join(), reference.join())
    });
    let authority_failed = authority_failed
        .map_err(|_| std::io::Error::other("Authority command thread panicked"))??;
    let reference_applied = reference_applied
        .map_err(|_| std::io::Error::other("Relying Service command thread panicked"))??;
    let authority_recovered = run_apply(
        &database_url,
        GovernanceRole::Authority,
        &authority_job,
        KeyAccess::Available,
    )?;
    let authority_repeated = run_apply(
        &database_url,
        GovernanceRole::Authority,
        &authority_job,
        KeyAccess::Available,
    )?;
    let reference_repeated = run_apply(
        &database_url,
        GovernanceRole::RelyingService,
        &reference_job,
        KeyAccess::Available,
    )?;
    let export_cutoff = (100 + 90 * 24 * 60 * 60).to_string();
    let authority_export = run_authority(
        &database_url,
        &[
            "export",
            "--snapshot-cutoff",
            &export_cutoff,
            "--page-size",
            "1000",
        ],
    )?;
    let reference_export = run_reference(
        &database_url,
        &[
            "export",
            "--snapshot-cutoff",
            &export_cutoff,
            "--page-size",
            "1000",
        ],
    )?;
    let reference_applied = serde_json::from_slice::<Value>(&reference_applied.stdout)?;
    let authority_recovered = serde_json::from_slice::<Value>(&authority_recovered.stdout)?;
    let authority_repeated = serde_json::from_slice::<Value>(&authority_repeated.stdout)?;
    let reference_repeated = serde_json::from_slice::<Value>(&reference_repeated.stdout)?;
    let combined_output = [authority_export.stdout, reference_export.stdout].concat();
    let combined_output = String::from_utf8(combined_output)?;

    // Assert
    assert!(!authority_failed.status.success());
    assert_eq!(reference_applied["status"], "completed");
    assert_eq!(authority_recovered["status"], "completed");
    assert_eq!(authority_repeated["pseudonymized_items"], 0);
    assert_eq!(reference_repeated["pseudonymized_items"], 0);
    assert!(combined_output.contains("\"context\":\"gate_authority\""));
    assert!(combined_output.contains("\"context\":\"relying_service\""));
    for prohibited in [
        PSEUDONYMIZATION_KEY,
        "signed-gate-pass-secret",
        "claimant_retention",
        "action_reference_retention",
        "account_retained",
        "pass_retention",
    ] {
        assert!(!combined_output.contains(prohibited));
    }

    Ok(())
}

fn manifest_arguments(manifest: &Value) -> Result<ManifestArguments, Box<dyn Error>> {
    Ok(ManifestArguments {
        job_id: manifest["job_id"]
            .as_str()
            .ok_or("manifest needs a job ID")?
            .to_owned(),
        manifest_digest: manifest["manifest_digest"]
            .as_str()
            .ok_or("manifest needs a digest")?
            .to_owned(),
    })
}

fn run_apply(
    database_url: &str,
    role: GovernanceRole,
    job: &ManifestArguments,
    key_access: KeyAccess,
) -> std::io::Result<std::process::Output> {
    let (binary, database_variable) = match role {
        GovernanceRole::Authority => (
            env!("CARGO_BIN_EXE_gate-authority-governance"),
            "BWG_AUTHORITY_DATABASE_URL",
        ),
        GovernanceRole::RelyingService => (
            env!("CARGO_BIN_EXE_reference-service-governance"),
            "BWG_RELYING_SERVICE_DATABASE_URL",
        ),
    };
    let mut command = Command::new(binary);
    command
        .args([
            "apply-retention",
            "--job-id",
            &job.job_id,
            "--manifest-digest",
            &job.manifest_digest,
            "--confirm-destruction",
        ])
        .env(database_variable, database_url)
        .env("BWG_GOVERNANCE_DESTRUCTIVE_ENABLED", "true");
    match key_access {
        KeyAccess::Available => {
            command.env("BWG_GOVERNANCE_PSEUDONYMIZATION_KEY", PSEUDONYMIZATION_KEY);
        }
        KeyAccess::Missing => {
            command.env_remove("BWG_GOVERNANCE_PSEUDONYMIZATION_KEY");
        }
    }
    command.output()
}

fn run_authority(
    database_url: &str,
    arguments: &[&str],
) -> Result<std::process::Output, Box<dyn Error>> {
    Ok(
        Command::new(env!("CARGO_BIN_EXE_gate-authority-governance"))
            .args(arguments)
            .env("BWG_AUTHORITY_DATABASE_URL", database_url)
            .env("BWG_GOVERNANCE_PSEUDONYMIZATION_KEY", PSEUDONYMIZATION_KEY)
            .output()?,
    )
}

fn run_reference(
    database_url: &str,
    arguments: &[&str],
) -> Result<std::process::Output, Box<dyn Error>> {
    Ok(
        Command::new(env!("CARGO_BIN_EXE_reference-service-governance"))
            .args(arguments)
            .env("BWG_RELYING_SERVICE_DATABASE_URL", database_url)
            .env("BWG_GOVERNANCE_PSEUDONYMIZATION_KEY", PSEUDONYMIZATION_KEY)
            .output()?,
    )
}
