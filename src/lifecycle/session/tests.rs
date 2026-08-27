use std::error::Error;

use super::*;

#[test]
fn only_session_local_stop_reasons_allow_replacement() {
    // Arrange
    let allowed = [
        SessionStopReason::WorkerReboot,
        SessionStopReason::MonotonicReset,
        SessionStopReason::UncertainTime,
        SessionStopReason::LeaseExpired,
        SessionStopReason::TransportDisconnected,
        SessionStopReason::SessionFailed,
    ];

    // Act
    let allowed_results = allowed.map(SessionStopReason::allows_replacement);
    let challenge_result = SessionStopReason::ChallengeCancelled.allows_replacement();

    // Assert
    assert_eq!(allowed_results, [true; 6]);
    assert!(!challenge_result);
}

#[test]
fn replacement_rejects_zero_generation() -> Result<(), Box<dyn Error>> {
    // Arrange
    let session_id = WorkSessionId::try_from("session_replacement_unit_02".to_owned())?;
    let replaced_session_id = WorkSessionId::try_from("session_replacement_unit_01".to_owned())?;

    // Act
    let result = SessionReplacement::persisted(
        session_id,
        replaced_session_id,
        0,
        SessionStopReason::SessionFailed,
    );

    // Assert
    assert_eq!(result, Err(LifecycleError::InvalidPersistedState));
    Ok(())
}

#[test]
fn replacement_rejects_self_reference() -> Result<(), Box<dyn Error>> {
    // Arrange
    let session_id = WorkSessionId::try_from("session_replacement_unit_01".to_owned())?;

    // Act
    let result = SessionReplacement::persisted(
        session_id.clone(),
        session_id,
        1,
        SessionStopReason::SessionFailed,
    );

    // Assert
    assert_eq!(result, Err(LifecycleError::InvalidPersistedState));
    Ok(())
}

#[test]
fn replacement_rejects_challenge_terminal_reason() -> Result<(), Box<dyn Error>> {
    // Arrange
    let session_id = WorkSessionId::try_from("session_replacement_unit_02".to_owned())?;
    let replaced_session_id = WorkSessionId::try_from("session_replacement_unit_01".to_owned())?;

    // Act
    let result = SessionReplacement::persisted(
        session_id,
        replaced_session_id,
        1,
        SessionStopReason::ChallengeSatisfied,
    );

    // Assert
    assert_eq!(result, Err(LifecycleError::InvalidPersistedState));
    Ok(())
}
