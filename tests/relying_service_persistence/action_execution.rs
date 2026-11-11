use super::*;

#[tokio::test]
async fn expired_action_lease_recovers_one_immutable_success() -> Result<(), Box<dyn Error>> {
    // Arrange
    let pending = create_pending_redemption().await?;
    let unavailable_worker = ReferenceApplication::connect_postgres(
        pending.config.clone(),
        pending.database.database_url(),
    )
    .await?;
    let first_worker = ActionWorkerId::try_from("action_worker_first_01".to_owned())?;
    let unavailable = unavailable_worker
        .process_next_action(&first_worker, pending.accepted_at)
        .await;
    assert!(matches!(
        unavailable,
        Err(ReferenceApplicationError::ExecutionUnavailable)
    ));

    // Act
    let replacement = ReferenceApplication::connect_postgres(
        pending.config.with_account_creation_executor(),
        pending.database.database_url(),
    )
    .await?;
    let replacement_worker = ActionWorkerId::try_from("action_worker_replacement_01".to_owned())?;
    let before_expiry = replacement
        .process_next_action(&replacement_worker, pending.accepted_at + 1)
        .await?;
    let recovered = replacement
        .process_next_action(&replacement_worker, pending.accepted_at + 31)
        .await?;
    let repeated = replacement
        .process_next_action(&replacement_worker, pending.accepted_at + 32)
        .await?;

    // Assert
    assert_eq!(before_expiry, ActionProcessingOutcome::NoWork);
    assert_eq!(
        recovered,
        ActionProcessingOutcome::Succeeded {
            redemption_id: pending.redemption_id.clone()
        }
    );
    assert_eq!(repeated, ActionProcessingOutcome::NoWork);

    Ok(())
}

#[tokio::test]
async fn exhausted_action_attempts_create_one_immutable_failure() -> Result<(), Box<dyn Error>> {
    // Arrange
    let pending = create_pending_redemption().await?;
    let unavailable = ReferenceApplication::connect_postgres(
        pending.config.clone(),
        pending.database.database_url(),
    )
    .await?;
    let worker = ActionWorkerId::try_from("action_worker_exhaustion_01".to_owned())?;

    // Act
    for offset in [0, 31, 62] {
        assert!(matches!(
            unavailable
                .process_next_action(&worker, pending.accepted_at + offset)
                .await,
            Err(ReferenceApplicationError::ExecutionUnavailable)
        ));
    }
    let exhausted = unavailable
        .process_next_action(&worker, pending.accepted_at + 93)
        .await?;
    let lookup_url = format!(
        "{}/account-creation/outcomes/{}",
        pending.reference_url, pending.action_reference
    );
    let proof = pending.claimant.sign_outcome_proof(
        &lookup_url,
        &pending.action_reference,
        "proof_outcome_exhausted_01",
        pending.accepted_at,
    )?;
    let outcome = reqwest::Client::new()
        .get(lookup_url)
        .header(CLAIMANT_PROOF_HEADER, proof)
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    let enabled = ReferenceApplication::connect_postgres(
        pending.config.with_account_creation_executor(),
        pending.database.database_url(),
    )
    .await?;
    let after_failure = enabled
        .process_next_action(&worker, pending.accepted_at + 94)
        .await?;

    // Assert
    assert_eq!(exhausted, ActionProcessingOutcome::NoWork);
    assert_eq!(outcome["outcome"]["status"], "failed");
    assert_eq!(outcome["outcome"]["reason"], "action_execution_exhausted");
    assert_eq!(after_failure, ActionProcessingOutcome::NoWork);

    Ok(())
}
