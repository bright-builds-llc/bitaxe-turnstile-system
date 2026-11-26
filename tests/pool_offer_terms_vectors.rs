use bwg_core::pool_offer::{
    MaterialPoolOfferChange, PoolOffer, PoolOfferChange, PoolOfferError, classify_pool_offer_change,
};
use serde::Deserialize;
use serde_json::Value;

const VECTORS: &str = include_str!("../conformance/bwg-0.1/pool-offer-terms-vectors.json");

#[derive(Deserialize)]
struct TermsVectors {
    profile: String,
    base_offer: Value,
    cases: Vec<TermsCase>,
}

#[derive(Deserialize)]
struct TermsCase {
    id: String,
    replace: String,
    with: Value,
    expected: Outcome,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Outcome {
    Equivalent,
    EconomicTermsChanged,
    PayoutTermsChanged,
    InvalidRewardPolicy,
    InvalidPayoutRequirements,
    RejectedShape,
}

fn vectors() -> Result<TermsVectors, serde_json::Error> {
    serde_json::from_str(VECTORS)
}

fn outcome(base: &PoolOffer, candidate: Value) -> Result<Outcome, String> {
    let Ok(candidate) = serde_json::from_value::<PoolOffer>(candidate) else {
        return Ok(Outcome::RejectedShape);
    };
    match classify_pool_offer_change(base, &candidate) {
        Ok(PoolOfferChange::Equivalent) => Ok(Outcome::Equivalent),
        Ok(PoolOfferChange::MateriallyChanged { changes }) => match changes.as_slice() {
            [MaterialPoolOfferChange::EconomicTerms] => Ok(Outcome::EconomicTermsChanged),
            [MaterialPoolOfferChange::PayoutTerms] => Ok(Outcome::PayoutTermsChanged),
            other => Err(format!("unexpected changes {other:?}")),
        },
        Err(PoolOfferError::InvalidRewardPolicy) => Ok(Outcome::InvalidRewardPolicy),
        Err(PoolOfferError::InvalidPayoutRequirements) => Ok(Outcome::InvalidPayoutRequirements),
        Err(other) => Err(format!("unexpected error {other}")),
    }
}

#[test]
fn pool_offer_terms_vectors_name_the_bwg_0_1_profile() -> Result<(), serde_json::Error> {
    // Act
    let vectors = vectors()?;

    // Assert
    assert_eq!(vectors.profile, "BWG/0.1");
    Ok(())
}

#[test]
fn base_offer_is_a_valid_reference_offer() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let vectors = vectors()?;
    let base: PoolOffer = serde_json::from_value(vectors.base_offer)?;

    // Act
    let change = classify_pool_offer_change(&base, &base)?;

    // Assert
    assert_eq!(change, PoolOfferChange::Equivalent);
    Ok(())
}

#[test]
fn offer_terms_follow_the_vectors() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let vectors = vectors()?;
    let base: PoolOffer = serde_json::from_value(vectors.base_offer.clone())?;

    for case in vectors.cases {
        let mut candidate = vectors.base_offer.clone();
        let Some(field) = candidate.get_mut(&case.replace) else {
            return Err(format!("{}: the base offer has no {}", case.id, case.replace).into());
        };
        *field = case.with;

        // Act
        let result = outcome(&base, candidate);

        // Assert
        assert_eq!(result, Ok(case.expected), "{}", case.id);
    }
    Ok(())
}
