use std::error::Error;

use serde_json::json;

use super::*;
use crate::pool_offer::classify_pool_offer_change;

#[test]
fn valid_equivalent_decision_requires_a_replacement_session() -> Result<(), Box<dyn Error>> {
    // Arrange
    let prior = test_offer()?;
    // Act
    let result = PoolOfferReplacementDecision::persisted(
        session("session_replaced_01")?,
        Some(session("session_replacement_01")?),
        prior.clone(),
        prior,
        "signed-candidate".to_owned(),
        PoolOfferChange::Equivalent,
    )?;
    // Assert
    assert_eq!(result.status(), PoolOfferReplacementStatus::Equivalent);
    Ok(())
}

#[test]
fn valid_material_decision_has_no_replacement_session() -> Result<(), Box<dyn Error>> {
    // Arrange
    let prior = test_offer()?;
    let candidate = material_offer(&prior)?;
    let change = classify_pool_offer_change(&prior, &candidate)?;
    // Act
    let result = PoolOfferReplacementDecision::persisted(
        session("session_replaced_02")?,
        None,
        prior,
        candidate,
        "signed-candidate".to_owned(),
        change,
    )?;
    // Assert
    assert_eq!(
        result.status(),
        PoolOfferReplacementStatus::PendingReconfirmation
    );
    Ok(())
}

#[test]
fn decision_rejects_empty_candidate_signature() -> Result<(), Box<dyn Error>> {
    // Arrange
    let prior = test_offer()?;
    // Act
    let result = PoolOfferReplacementDecision::persisted(
        session("session_replaced_03")?,
        Some(session("session_replacement_03")?),
        prior.clone(),
        prior,
        String::new(),
        PoolOfferChange::Equivalent,
    );
    // Assert
    assert!(matches!(result, Err(PoolOfferError::InvalidPoolOffer)));
    Ok(())
}

#[test]
fn equivalent_decision_rejects_missing_replacement_session() -> Result<(), Box<dyn Error>> {
    // Arrange
    let prior = test_offer()?;
    // Act
    let result = PoolOfferReplacementDecision::persisted(
        session("session_replaced_04")?,
        None,
        prior.clone(),
        prior,
        "signed-candidate".to_owned(),
        PoolOfferChange::Equivalent,
    );
    // Assert
    assert!(matches!(result, Err(PoolOfferError::InvalidPoolOffer)));
    Ok(())
}

#[test]
fn material_decision_rejects_unexpected_replacement_session() -> Result<(), Box<dyn Error>> {
    // Arrange
    let prior = test_offer()?;
    let candidate = material_offer(&prior)?;
    let change = classify_pool_offer_change(&prior, &candidate)?;
    // Act
    let result = PoolOfferReplacementDecision::persisted(
        session("session_replaced_05")?,
        Some(session("session_replacement_05")?),
        prior,
        candidate,
        "signed-candidate".to_owned(),
        change,
    );
    // Assert
    assert!(matches!(result, Err(PoolOfferError::InvalidPoolOffer)));
    Ok(())
}

#[test]
fn sha256_digest_rejects_non_base64url_bytes() {
    // Arrange
    let malformed = "!".repeat(43);
    // Act
    let result = Sha256Base64Url::try_from(malformed);
    // Assert
    assert!(matches!(result, Err(PoolOfferError::InvalidPoolOffer)));
}

#[test]
fn material_confirmation_accepts_a_parsed_digest() -> Result<(), Box<dyn Error>> {
    // Arrange
    let signed =
        super::super::test_signed_default_pool_offers(ActionPolicy::AccountCreationElevatedV1);
    let digest = Sha256Base64Url::try_from("A".repeat(43))?;
    // Act
    let result = MaterialPoolOfferConfirmation::persisted(
        session("session_confirmation_old_01")?,
        session("session_confirmation_new_01")?,
        signed,
        digest,
    )?;
    // Assert
    assert_eq!(result.disclosure_digest_sha256(), "A".repeat(43));
    Ok(())
}

#[test]
fn material_replacement_disclosure_digest_matches_stable_vector() -> Result<(), Box<dyn Error>> {
    // Arrange
    let prior = test_offer()?;
    let candidate = material_offer(&prior)?;
    let change = classify_pool_offer_change(&prior, &candidate)?;

    // Act
    let digest = material_replacement_disclosure_digest(
        &session("session_disclosure_old_01")?,
        &session("session_disclosure_new_01")?,
        &prior,
        &candidate,
        &change,
    )?;

    // Assert
    assert_eq!(
        digest.as_str(),
        "tMVwhcz07fHhJfFWn3sMOpddzYaRD5zDM2-hWMFb6Sw"
    );
    Ok(())
}

#[test]
fn material_confirmation_signature_digest_matches_stable_vector() -> Result<(), Box<dyn Error>> {
    // Arrange
    let signed: SignedPoolOfferSet = serde_json::from_value(json!({
        "offers": [test_offer()?],
        "signature": "header.payload.signature",
    }))?;
    let confirmation = MaterialPoolOfferConfirmation::persisted(
        session("session_signature_old_01")?,
        session("session_signature_new_01")?,
        signed,
        Sha256Base64Url::try_from("A".repeat(43))?,
    )?;

    // Act
    let digest = confirmation.signature_digest_sha256();

    // Assert
    assert_eq!(
        digest.as_str(),
        "JW0E205eSsMIdR7QiFtyK3WGMFZ8U6cSXtn70Gjlw_Y"
    );
    Ok(())
}

#[test]
fn failover_projection_requires_an_equivalent_candidate_session() -> Result<(), Box<dyn Error>> {
    // Arrange
    let input = projection_input(PoolOfferReplacementStatus::Equivalent, None)?;

    // Act
    let result = PoolFailoverProjection::persisted(input);

    // Assert
    assert!(matches!(result, Err(PoolOfferError::InvalidPoolOffer)));
    Ok(())
}

#[test]
fn failover_projection_accepts_an_equivalent_candidate_session() -> Result<(), Box<dyn Error>> {
    // Arrange
    let input = projection_input(
        PoolOfferReplacementStatus::Equivalent,
        Some(SessionLifecycleState::Ready),
    )?;

    // Act
    let projection = PoolFailoverProjection::persisted(input)?;

    // Assert
    assert_eq!(
        projection.recovery_category(),
        PoolFailoverRecoveryCategory::AutomaticEquivalent
    );
    assert_eq!(
        projection.candidate_session().state(),
        PoolFailoverSessionState::Ready
    );
    assert!(projection.maybe_pending_offer().is_none());
    Ok(())
}

#[test]
fn session_projection_rejects_a_stop_reason_for_an_active_state() -> Result<(), Box<dyn Error>> {
    // Arrange
    let session_id = session("session_projection_active_reason_01")?;

    // Act
    let result = PoolFailoverSessionProjection::persisted(
        session_id,
        SessionLifecycleState::Ready,
        Some(SessionStopReason::SessionFailed),
    );

    // Assert
    assert!(matches!(result, Err(PoolOfferError::InvalidPoolOffer)));
    Ok(())
}

#[test]
fn session_projection_requires_a_stop_reason_for_a_terminal_state() -> Result<(), Box<dyn Error>> {
    // Arrange
    let session_id = session("session_projection_missing_reason_01")?;

    // Act
    let result =
        PoolFailoverSessionProjection::persisted(session_id, SessionLifecycleState::Failed, None);

    // Assert
    assert!(matches!(result, Err(PoolOfferError::InvalidPoolOffer)));
    Ok(())
}

#[test]
fn session_projection_accepts_a_matching_terminal_reason() -> Result<(), Box<dyn Error>> {
    // Arrange
    let session_id = session("session_projection_terminal_reason_01")?;

    // Act
    let projection = PoolFailoverSessionProjection::persisted(
        session_id,
        SessionLifecycleState::Failed,
        Some(SessionStopReason::SessionFailed),
    )?;

    // Assert
    assert_eq!(projection.state(), PoolFailoverSessionState::Failed);
    assert_eq!(projection.maybe_stop_reason(), Some("session_failed"));
    Ok(())
}

#[test]
fn failover_projection_holds_material_candidate_pending() -> Result<(), Box<dyn Error>> {
    // Arrange
    let input = projection_input(PoolOfferReplacementStatus::PendingReconfirmation, None)?;

    // Act
    let projection = PoolFailoverProjection::persisted(input)?;

    // Assert
    assert_eq!(
        projection.recovery_category(),
        PoolFailoverRecoveryCategory::TrustedConfirmationRequired
    );
    assert_eq!(
        projection.candidate_session().state(),
        PoolFailoverSessionState::PendingConfirmation
    );
    assert!(projection.maybe_pending_offer().is_some());
    Ok(())
}

#[test]
fn failover_projection_promotes_confirmed_material_candidate() -> Result<(), Box<dyn Error>> {
    // Arrange
    let input = projection_input(
        PoolOfferReplacementStatus::PendingReconfirmation,
        Some(SessionLifecycleState::Leased),
    )?;

    // Act
    let projection = PoolFailoverProjection::persisted(input)?;

    // Assert
    assert_eq!(
        projection.recovery_category(),
        PoolFailoverRecoveryCategory::TrustedConfirmationAccepted
    );
    assert_eq!(
        projection.candidate_session().state(),
        PoolFailoverSessionState::Leased
    );
    assert!(projection.maybe_pending_offer().is_none());
    Ok(())
}

fn projection_input(
    replacement_status: PoolOfferReplacementStatus,
    maybe_candidate_state: Option<SessionLifecycleState>,
) -> Result<PersistedPoolFailoverProjection, Box<dyn Error>> {
    let prior_offer = test_offer()?;
    let candidate_offer = material_offer(&prior_offer)?;
    Ok(PersistedPoolFailoverProjection {
        challenge_id: crate::challenge::ChallengeId::try_from(
            "challenge_00000000000000000000000000000001".to_owned(),
        )?,
        predecessor_session_id: session("session_projection_old_01")?,
        candidate_session_id: session("session_projection_new_01")?,
        replacement_status,
        prior_offer,
        candidate_offer,
        predecessor_state: SessionLifecycleState::Failed,
        maybe_predecessor_stop_reason: Some(SessionStopReason::SessionFailed),
        maybe_candidate_state,
        maybe_candidate_stop_reason: None,
    })
}

fn test_offer() -> Result<PoolOffer, Box<dyn Error>> {
    Ok(super::super::default_pool_offer(
        "https://authority.example/privacy",
        "https://authority.example/terms",
    )?)
}

fn material_offer(prior: &PoolOffer) -> Result<PoolOffer, Box<dyn Error>> {
    let mut value = serde_json::to_value(prior)?;
    value["privacy_terms_url"] = json!("https://authority.example/privacy-v2");
    Ok(serde_json::from_value(value)?)
}

fn session(value: &str) -> Result<WorkSessionId, Box<dyn Error>> {
    Ok(WorkSessionId::try_from(value.to_owned())?)
}
