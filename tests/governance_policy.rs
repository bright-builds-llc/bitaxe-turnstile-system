use bwg_core::governance::{
    EligibilityReason, GovernedRecordClass, RetentionAction, RetentionCandidate, RetentionPolicy,
    RetentionState, plan_candidate,
};

#[test]
fn replay_material_is_ineligible_until_its_retention_floor()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let policy = RetentionPolicy::hosted_default();
    let candidate = RetentionCandidate::new(
        GovernedRecordClass::ClaimantIssuanceProofReplay,
        RetentionState::Identifying,
        100,
    );

    // Act
    let before_floor = plan_candidate(&candidate, 99, policy)?;
    let at_floor = plan_candidate(&candidate, 100, policy)?;

    // Assert
    assert!(before_floor.is_none());
    assert_eq!(
        at_floor.expect("floor should permit cleanup").action(),
        RetentionAction::Delete
    );
    assert_eq!(
        at_floor.expect("floor should explain cleanup").reason(),
        EligibilityReason::ProtocolRetentionFloorReached
    );

    Ok(())
}

#[test]
fn retention_policy_rejects_zero_or_inverted_windows() {
    // Arrange
    let operational_window = 30 * 24 * 60 * 60;
    let tombstone_window = 90 * 24 * 60 * 60;

    // Act
    let below_hosted_default = RetentionPolicy::new(operational_window - 1, tombstone_window);
    let inverted = RetentionPolicy::new(tombstone_window, 30 * 24 * 60 * 60);

    // Assert
    assert!(below_hosted_default.is_err());
    assert!(inverted.is_err());
}
