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
