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
fn progress_service_rejects_duplicate_challenge_registration()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let service = ProgressService::default();
    let challenge_id = ChallengeId::try_from("challenge_duplicate01".to_owned())?;
    let work_requirement = CreditedWork::try_from("4295032833".to_owned())?;
    service.register_challenge(challenge_id.clone(), work_requirement)?;

    // Act
    let result = service.register_challenge(challenge_id, work_requirement);

    // Assert
    assert_eq!(result, Err(ProgressError::DuplicateChallenge));

    Ok(())
}

#[test]
fn progress_service_rejects_unknown_challenge_subscription()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let service = ProgressService::default();
    let challenge_id = ChallengeId::try_from("challenge_unknown01".to_owned())?;

    // Act
    let result = service.subscribe(&challenge_id);

    // Assert
    assert!(matches!(result, Err(ProgressError::UnknownChallenge)));

    Ok(())
}

#[test]
fn authority_wide_share_fingerprint_does_not_credit_two_challenges()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let (service, first_challenge, second_challenge, first_session, second_session) =
        service_with_two_challenges()?;
    let mut first_input = valid_event_input()?;
    first_input.work_session_id = first_session;
    let mut second_input = valid_event_input()?;
    second_input.event_id = AcceptedWorkEventId::try_from("event_second01".to_owned())?;
    second_input.work_session_id = second_session;

    // Act
    let first_ack = service.report(AcceptedWorkEvent::try_from(first_input)?)?;
    let second_ack = service.report(AcceptedWorkEvent::try_from(second_input)?)?;
    let (first_progress, _first_updates) = service.subscribe(&first_challenge)?;
    let (second_progress, _second_updates) = service.subscribe(&second_challenge)?;

    // Assert
    assert_eq!(first_ack.disposition(), AcceptedWorkDisposition::Credited);
    assert_eq!(
        second_ack.disposition(),
        AcceptedWorkDisposition::DuplicateShare
    );
    assert_eq!(
        first_progress.verified_progress().to_decimal_string(),
        "4295032833"
    );
    assert_eq!(second_progress.verified_progress().to_decimal_string(), "0");

    Ok(())
}

#[test]
fn conflicting_event_identity_reuse_across_challenges_fails_closed()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let (service, _first_challenge, second_challenge, first_session, second_session) =
        service_with_two_challenges()?;
    let mut first_input = valid_event_input()?;
    first_input.work_session_id = first_session;
    let mut conflicting_input = valid_event_input()?;
    conflicting_input.work_session_id = second_session;
    service.report(AcceptedWorkEvent::try_from(first_input)?)?;

    // Act
    let result = service.report(AcceptedWorkEvent::try_from(conflicting_input)?);
    let (second_progress, _updates) = service.subscribe(&second_challenge)?;

    // Assert
    assert_eq!(result, Err(ProgressError::ConflictingEventReplay));
    assert_eq!(second_progress.verified_progress().to_decimal_string(), "0");

    Ok(())
}

#[test]
fn conflicting_event_identity_reuse_within_challenge_fails_closed() -> Result<(), ProgressError> {
    // Arrange
    let required_work = CreditedWork::try_from("4295032833".to_owned())?;
    let mut progress = ChallengeProgress::new(required_work);
    let first_input = valid_event_input()?;
    let mut conflicting_input = valid_event_input()?;
    conflicting_input.share_fingerprint =
        ShareFingerprint::try_from("share_conflict01".to_owned())?;
    progress.register_session(first_input.work_session_id.clone())?;
    progress.accept(AcceptedWorkEvent::try_from(first_input)?)?;

    // Act
    let result = progress.accept(AcceptedWorkEvent::try_from(conflicting_input)?);

    // Assert
    assert_eq!(result, Err(ProgressError::ConflictingEventReplay));

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

type TwoChallengeService = (
    ProgressService,
    ChallengeId,
    ChallengeId,
    WorkSessionId,
    WorkSessionId,
);

fn service_with_two_challenges() -> Result<TwoChallengeService, Box<dyn std::error::Error>> {
    let service = ProgressService::default();
    let first_challenge = ChallengeId::try_from("challenge_first01".to_owned())?;
    let second_challenge = ChallengeId::try_from("challenge_second01".to_owned())?;
    let first_session = WorkSessionId::try_from("session_first01".to_owned())?;
    let second_session = WorkSessionId::try_from("session_second01".to_owned())?;
    let work_requirement = CreditedWork::try_from("4398046511104".to_owned())?;
    service.register_challenge(first_challenge.clone(), work_requirement)?;
    service.register_challenge(second_challenge.clone(), work_requirement)?;
    service.register_session(&first_challenge, first_session.clone())?;
    service.register_session(&second_challenge, second_session.clone())?;
    Ok((
        service,
        first_challenge,
        second_challenge,
        first_session,
        second_session,
    ))
}
