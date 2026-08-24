use super::*;

#[tokio::test]
async fn challenge_expiry_permanently_fails_unsigned_issuance() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let application = AuthorityApplication::connect_postgres(
        authority_config_with_signer()?,
        database.database_url(),
    )
    .await?;
    let adapter = application.simulated_pool_adapter();
    let server = RunningServer::spawn(authority::router(application.clone())).await?;
    let claimant = Claimant::generate()?;
    let challenge = issue_challenge(&server.base_url, &claimant.public_jwk_json).await?;
    let challenge_id = ChallengeId::try_from(
        challenge["challenge_id"]
            .as_str()
            .ok_or("challenge response needs an identifier")?
            .to_owned(),
    )?;
    let challenge_expiry = challenge["expires_at_unix_seconds"]
        .as_u64()
        .ok_or("challenge response needs an expiry")?;
    let session_id = WorkSessionId::try_from("session_deadline_failure_01".to_owned())?;
    register_test_session(&adapter, &challenge_id, session_id.clone()).await?;
    let lease = adapter
        .start_lease(
            &session_id,
            WorkerClock::new("boot_deadline_failure_01", 0)?,
        )
        .await?;
    adapter
        .report(
            light_target_event_with_id(
                "event_deadline_failure_01",
                "share_deadline_failure_01",
                session_id,
            )?,
            &lease,
            WorkerClock::new("boot_deadline_failure_01", 1)?,
        )
        .await?;

    // Act
    let processing = application
        .process_next_issuance(
            &IssuanceWorkerId::try_from("worker_deadline_failure_01".to_owned())?,
            challenge_expiry,
        )
        .await?;
    let public_lookup_url = format!(
        "https://authority.example/v0/challenges/{}/gate-pass",
        challenge_id.as_str()
    );
    let proof_now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let proof = claimant.sign_issuance_proof(
        &public_lookup_url,
        challenge_id.as_str(),
        "proof_deadline_failure_01",
        proof_now,
    )?;
    let lookup = reqwest::Client::new()
        .get(format!(
            "{}/v0/challenges/{}/gate-pass",
            server.base_url,
            challenge_id.as_str()
        ))
        .header(CLAIMANT_PROOF_HEADER, proof)
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;

    // Assert
    assert_eq!(processing, IssuanceProcessingOutcome::NoWork);
    assert_eq!(lookup, json!({ "status": "failed" }));

    Ok(())
}
