use std::process::Command;

use super::*;

const PSEUDONYMIZATION_KEY: &str = "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A";

#[tokio::test]
async fn outcome_lookup_survives_marker_retirement_until_aggregate_retention_floor()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let pending = create_pending_redemption().await?;
    let executor = ReferenceApplication::connect_postgres(
        pending.config.clone().with_account_creation_executor(),
        pending.database.database_url(),
    )
    .await?;
    executor
        .process_next_action(
            &ActionWorkerId::try_from("action_worker_governance_01".to_owned())?,
            pending.accepted_at,
        )
        .await?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let terminal_at = now - 31 * 24 * 60 * 60;
    let pool = sqlx::PgPool::connect(pending.database.database_url()).await?;
    sqlx::query(include_str!(
        "../fixtures/governance/age_relying_outcome.sql"
    ))
    .bind(&pending.redemption_id)
    .bind(i64::try_from(terminal_at)?)
    .execute(&pool)
    .await?;
    sqlx::query(include_str!(
        "../fixtures/governance/open_relying_public_lookup.sql"
    ))
    .bind(&pending.redemption_id)
    .bind(i64::try_from(now + 60)?)
    .execute(&pool)
    .await?;
    sqlx::query(include_str!(
        "../fixtures/governance/age_pass_consumption.sql"
    ))
    .bind(&pending.redemption_id)
    .bind(i64::try_from(terminal_at)?)
    .bind(i64::try_from(now - 1)?)
    .execute(&pool)
    .await?;
    let lookup_url = format!(
        "{}/account-creation/outcomes/{}",
        pending.reference_url, pending.action_reference
    );
    let before_proof = pending.claimant.sign_outcome_proof(
        &lookup_url,
        &pending.action_reference,
        "proof_governance_before_marker_retention",
        now,
    )?;
    let before = reqwest::Client::new()
        .get(&lookup_url)
        .header(CLAIMANT_PROOF_HEADER, before_proof)
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;

    // Act
    let marker_plan = run_governance(
        pending.database.database_url(),
        &["plan-retention", "--as-of", &now.to_string()],
    )?;
    let marker_manifest = serde_json::from_slice::<Value>(&marker_plan.stdout)?;
    let marker_apply = apply_governance(pending.database.database_url(), &marker_manifest)?;
    let restarted_application = ReferenceApplication::connect_postgres(
        pending.config.clone().with_account_creation_executor(),
        pending.database.database_url(),
    )
    .await?;
    let restarted_server =
        RunningServer::spawn(reference_service::router(restarted_application)).await?;
    let restarted_lookup_url = format!(
        "{}/account-creation/outcomes/{}",
        restarted_server.base_url, pending.action_reference
    );
    let after_marker_proof = pending.claimant.sign_outcome_proof(
        &lookup_url,
        &pending.action_reference,
        "proof_governance_after_marker_retention",
        now,
    )?;
    let after_marker = reqwest::Client::new()
        .get(&restarted_lookup_url)
        .header(CLAIMANT_PROOF_HEADER, after_marker_proof)
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    sqlx::query(include_str!(
        "../fixtures/governance/expire_relying_public_lookup.sql"
    ))
    .bind(&pending.redemption_id)
    .bind(i64::try_from(now - 1)?)
    .execute(&pool)
    .await?;
    let aggregate_plan = run_governance(
        pending.database.database_url(),
        &["plan-retention", "--as-of", &now.to_string()],
    )?;
    let aggregate_manifest = serde_json::from_slice::<Value>(&aggregate_plan.stdout)?;
    let aggregate_apply = apply_governance(pending.database.database_url(), &aggregate_manifest)?;
    let after_aggregate_proof = pending.claimant.sign_outcome_proof(
        &lookup_url,
        &pending.action_reference,
        "proof_governance_after_aggregate_retention",
        now,
    )?;
    let after_aggregate = reqwest::Client::new()
        .get(restarted_lookup_url)
        .header(CLAIMANT_PROOF_HEADER, after_aggregate_proof)
        .send()
        .await?;

    // Assert
    assert_eq!(before["outcome"]["status"], "succeeded");
    assert_eq!(
        marker_manifest["planned_counts"][0]["record_class"],
        "pass_consumption"
    );
    assert!(marker_apply.status.success());
    assert_eq!(after_marker, before);
    assert_eq!(
        aggregate_manifest["planned_counts"][0]["record_class"],
        "relying_service_operational"
    );
    assert!(aggregate_apply.status.success());
    assert_eq!(after_aggregate.status(), reqwest::StatusCode::NOT_FOUND);
    assert_eq!(
        after_aggregate.json::<Value>().await?["error"],
        "outcome_unavailable"
    );

    Ok(())
}

fn run_governance(
    database_url: &str,
    arguments: &[&str],
) -> Result<std::process::Output, Box<dyn Error>> {
    Ok(
        Command::new(env!("CARGO_BIN_EXE_reference-service-governance"))
            .args(arguments)
            .env("BWG_RELYING_SERVICE_DATABASE_URL", database_url)
            .env("BWG_GOVERNANCE_DESTRUCTIVE_ENABLED", "true")
            .env("BWG_GOVERNANCE_PSEUDONYMIZATION_KEY", PSEUDONYMIZATION_KEY)
            .output()?,
    )
}

fn apply_governance(
    database_url: &str,
    manifest: &Value,
) -> Result<std::process::Output, Box<dyn Error>> {
    run_governance(
        database_url,
        &[
            "apply-retention",
            "--job-id",
            manifest["job_id"].as_str().ok_or("plan needs a job ID")?,
            "--manifest-digest",
            manifest["manifest_digest"]
                .as_str()
                .ok_or("plan needs a digest")?,
            "--confirm-destruction",
        ],
    )
}
