use super::*;

#[test]
fn opaque_progress_identifiers_enforce_their_namespaces() {
    // Arrange
    let invalid = "wrong_01".to_owned();

    // Act
    let event_result = AcceptedWorkEventId::try_from(invalid.clone());
    let session_result = WorkSessionId::try_from(invalid.clone());
    let share_result = ShareFingerprint::try_from(invalid);

    // Assert
    assert_eq!(event_result, Err(ProgressError::InvalidIdentifier));
    assert_eq!(session_result, Err(ProgressError::InvalidIdentifier));
    assert_eq!(share_result, Err(ProgressError::InvalidIdentifier));
}

#[test]
fn zero_receipt_time_is_rejected() {
    // Arrange and Act
    let result = ReceiptTime::try_from(0);

    // Assert
    assert_eq!(result, Err(ProgressError::InvalidReceiptTime));
}

#[test]
fn zero_assigned_target_is_rejected() -> Result<(), ProgressError> {
    // Arrange
    let mut input = valid_event_input()?;
    input.assigned_target = [0; 32];

    // Act
    let result = AcceptedWorkEvent::try_from(input);

    // Assert
    assert!(matches!(result, Err(ProgressError::InvalidWork(_))));

    Ok(())
}

#[test]
fn duplicate_work_session_registration_is_rejected() -> Result<(), ProgressError> {
    // Arrange
    let required_work = CreditedWork::try_from("4295032833".to_owned())?;
    let session_id = WorkSessionId::try_from("session_duplicate_registration".to_owned())?;
    let mut progress = ChallengeProgress::new(required_work);
    progress.register_session(session_id.clone())?;

    // Act
    let result = progress.register_session(session_id);

    // Assert
    assert_eq!(result, Err(ProgressError::DuplicateWorkSession));

    Ok(())
}

#[test]
fn event_from_unknown_work_session_is_rejected() -> Result<(), ProgressError> {
    // Arrange
    let required_work = CreditedWork::try_from("4295032833".to_owned())?;
    let mut progress = ChallengeProgress::new(required_work);
    let event = AcceptedWorkEvent::try_from(valid_event_input()?)?;

    // Act
    let result = progress.accept(event);

    // Assert
    assert_eq!(result, Err(ProgressError::UnknownWorkSession));

    Ok(())
}

#[test]
fn exact_threshold_marks_progress_satisfied() -> Result<(), ProgressError> {
    // Arrange
    let required_work = CreditedWork::try_from("4295032833".to_owned())?;
    let mut progress = ChallengeProgress::new(required_work);
    let input = valid_event_input()?;
    progress.register_session(input.work_session_id.clone())?;

    // Act
    progress.accept(AcceptedWorkEvent::try_from(input)?)?;

    // Assert
    assert!(progress.is_satisfied());

    Ok(())
}

#[test]
fn network_target_outcome_does_not_change_assigned_target_credit() -> Result<(), ProgressError> {
    // Arrange
    let required_work = CreditedWork::try_from("4295032833".to_owned())?;
    let below_input = valid_event_input()?;
    let mut network_input = valid_event_input()?;
    network_input.event_id = AcceptedWorkEventId::try_from("event_network_01".to_owned())?;
    network_input.share_fingerprint = ShareFingerprint::try_from("share_network_01".to_owned())?;
    network_input.network_target_outcome = NetworkTargetOutcome::NetworkTargetMet;
    let mut below_progress = ChallengeProgress::new(required_work);
    let mut network_progress = ChallengeProgress::new(required_work);
    below_progress.register_session(below_input.work_session_id.clone())?;
    network_progress.register_session(network_input.work_session_id.clone())?;

    // Act
    let below_ack = below_progress.accept(AcceptedWorkEvent::try_from(below_input)?)?;
    let network_ack = network_progress.accept(AcceptedWorkEvent::try_from(network_input)?)?;

    // Assert
    assert_eq!(
        below_ack.maybe_credited_work(),
        network_ack.maybe_credited_work()
    );

    Ok(())
}

#[test]
fn progress_service_rejects_duplicate_challenge_registration() -> Result<(), ProgressError> {
    // Arrange
    let service = ProgressService::default();
    let challenge_id = ProgressChallengeId::try_from("challenge_duplicate_01".to_owned())?;
    let work_requirement = CreditedWork::try_from("4295032833".to_owned())?;
    service.register_challenge(challenge_id.clone(), work_requirement)?;

    // Act
    let result = service.register_challenge(challenge_id, work_requirement);

    // Assert
    assert_eq!(result, Err(ProgressError::DuplicateChallenge));

    Ok(())
}

#[test]
fn progress_service_rejects_unknown_challenge_subscription() -> Result<(), ProgressError> {
    // Arrange
    let service = ProgressService::default();
    let challenge_id = ProgressChallengeId::try_from("challenge_unknown_01".to_owned())?;

    // Act
    let result = service.subscribe(&challenge_id);

    // Assert
    assert!(matches!(result, Err(ProgressError::UnknownChallenge)));

    Ok(())
}

fn valid_event_input() -> Result<AcceptedWorkEventInput, ProgressError> {
    let mut assigned_target = [0_u8; 32];
    assigned_target[4] = 0xff;
    assigned_target[5] = 0xff;
    Ok(AcceptedWorkEventInput {
        event_id: AcceptedWorkEventId::try_from("event_valid_01".to_owned())?,
        work_session_id: WorkSessionId::try_from("session_valid_01".to_owned())?,
        assigned_target,
        received_at: ReceiptTime::try_from(1_787_443_200)?,
        share_fingerprint: ShareFingerprint::try_from("share_valid_01".to_owned())?,
        network_target_outcome: NetworkTargetOutcome::BelowNetworkTarget,
        maybe_worker_report: None,
    })
}
