use std::process::Command;

use super::*;

const PSEUDONYMIZATION_KEY: &str = "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A";

#[tokio::test]
async fn retired_pass_lookup_is_gone_while_active_adapter_acknowledgements_remain_stable()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let application = AuthorityApplication::connect_postgres(
        authority_config_with_signer()?,
        database.database_url(),
    )
    .await?;
    let adapter = application.simulated_pool_adapter();
    let server = RunningServer::spawn(authority::router(application)).await?;
    let claimant = Claimant::generate()?;
    let retired_challenge = issue_challenge(&server.base_url, &claimant.public_jwk_json).await?;
    let retired_challenge_id = retired_challenge["challenge_id"]
        .as_str()
        .ok_or("challenge response needs an identifier")?;
    let retired_challenge_id_value = ChallengeId::try_from(retired_challenge_id.to_owned())?;
    let session_id = WorkSessionId::try_from("session_during_governance_01".to_owned())?;
    adapter
        .register_session(&retired_challenge_id_value, session_id.clone())
        .await?;
    let accepted_event = light_target_event_with_id(
        "event_during_governance_01",
        "share_during_governance_01",
        session_id,
    )?;
    let first_acknowledgement = adapter.report(accepted_event.clone()).await?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let pool = sqlx::PgPool::connect(database.database_url()).await?;
    sqlx::query(include_str!(
        "../fixtures/governance/mark_public_challenge_terminal.sql"
    ))
    .bind(retired_challenge_id)
    .bind(i64::try_from(now - 100)?)
    .execute(&pool)
    .await?;
    sqlx::query(include_str!(
        "../fixtures/governance/mark_public_issuance_issued.sql"
    ))
    .bind(retired_challenge_id)
    .bind(i64::try_from(now - 100)?)
    .bind(i64::try_from(now - 1)?)
    .execute(&pool)
    .await?;
    let public_lookup_url =
        format!("https://authority.example/v0/challenges/{retired_challenge_id}/gate-pass");
    let request_lookup_url = format!(
        "{}/v0/challenges/{retired_challenge_id}/gate-pass",
        server.base_url
    );
    let before_proof = claimant.sign_issuance_proof(
        &public_lookup_url,
        retired_challenge_id,
        "proof_before_pass_retention",
        now,
    )?;
    let before = reqwest::Client::new()
        .get(&request_lookup_url)
        .header(CLAIMANT_PROOF_HEADER, before_proof)
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    // Act
    let plan = Command::new(env!("CARGO_BIN_EXE_gate-authority-governance"))
        .args(["plan-retention", "--as-of", &now.to_string()])
        .env("BWG_AUTHORITY_DATABASE_URL", database.database_url())
        .output()?;
    let manifest = serde_json::from_slice::<Value>(&plan.stdout)?;
    let apply = Command::new(env!("CARGO_BIN_EXE_gate-authority-governance"))
        .args([
            "apply-retention",
            "--job-id",
            manifest["job_id"].as_str().ok_or("plan needs a job ID")?,
            "--manifest-digest",
            manifest["manifest_digest"]
                .as_str()
                .ok_or("plan needs a digest")?,
            "--confirm-destruction",
        ])
        .env("BWG_AUTHORITY_DATABASE_URL", database.database_url())
        .env("BWG_GOVERNANCE_DESTRUCTIVE_ENABLED", "true")
        .env("BWG_GOVERNANCE_PSEUDONYMIZATION_KEY", PSEUDONYMIZATION_KEY)
        .output()?;
    server.stop();
    let restarted_application = AuthorityApplication::connect_postgres(
        authority_config_with_signer()?,
        database.database_url(),
    )
    .await?;
    let restarted_adapter = restarted_application.simulated_pool_adapter();
    let restarted_server = RunningServer::spawn(authority::router(restarted_application)).await?;
    let replayed_acknowledgement = restarted_adapter.report(accepted_event).await?;
    let mut progress_response = reqwest::get(format!(
        "{}/v0/challenges/{retired_challenge_id}/events",
        restarted_server.base_url
    ))
    .await?;
    let progress = timeout(Duration::from_secs(2), progress_response.chunk())
        .await??
        .ok_or("progress stream ended before its snapshot")?;
    let after_proof = claimant.sign_issuance_proof(
        &public_lookup_url,
        retired_challenge_id,
        "proof_after_pass_retention",
        now,
    )?;
    let after_request_lookup_url = format!(
        "{}/v0/challenges/{retired_challenge_id}/gate-pass",
        restarted_server.base_url
    );
    let after = reqwest::Client::new()
        .get(after_request_lookup_url)
        .header(CLAIMANT_PROOF_HEADER, after_proof)
        .send()
        .await?;

    // Assert
    assert_eq!(before["status"], "issued");
    assert_eq!(before["gate_pass"], "signed-pass-public-retention");
    assert!(plan.status.success());
    assert!(apply.status.success());
    assert_eq!(replayed_acknowledgement, first_acknowledgement);
    let progress = String::from_utf8(progress.to_vec())?;
    assert!(progress.contains("\"verified_progress\":\"4398046511104\""));
    assert_eq!(after.status(), reqwest::StatusCode::GONE);
    assert_eq!(after.json::<Value>().await?["error"], "issuance_retired");

    Ok(())
}
