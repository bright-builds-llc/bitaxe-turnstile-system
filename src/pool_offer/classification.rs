use serde::{Deserialize, Serialize};

use super::{PoolOffer, PoolOfferError};

/// Consent-relevant term categories used for deterministic failover classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MaterialPoolOfferChange {
    EconomicTerms,
    PayoutTerms,
    PrivacyTerms,
    OperatorTerms,
    LicenseTerms,
}

/// Whether failover may reuse existing consent or must obtain fresh Work Consent.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PoolOfferChange {
    Equivalent,
    MateriallyChanged { changes: MaterialPoolOfferChanges },
}

/// Non-empty consent-relevant change set.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct MaterialPoolOfferChanges(Vec<MaterialPoolOfferChange>);

impl MaterialPoolOfferChanges {
    /// Deterministically ordered material changes.
    pub fn as_slice(&self) -> &[MaterialPoolOfferChange] {
        &self.0
    }
}

/// Classifies consent-relevant changes independently from pool identity and endpoint failover.
pub fn classify_pool_offer_change(
    consented: &PoolOffer,
    candidate: &PoolOffer,
) -> Result<PoolOfferChange, PoolOfferError> {
    consented.validate()?;
    candidate.validate()?;
    let mut changes = Vec::new();
    if consented.reward_policy != candidate.reward_policy {
        changes.push(MaterialPoolOfferChange::EconomicTerms);
    }
    if consented.payout_requirements != candidate.payout_requirements {
        changes.push(MaterialPoolOfferChange::PayoutTerms);
    }
    if consented.privacy_terms_url != candidate.privacy_terms_url {
        changes.push(MaterialPoolOfferChange::PrivacyTerms);
    }
    if consented.operator_terms_url != candidate.operator_terms_url {
        changes.push(MaterialPoolOfferChange::OperatorTerms);
    }
    if consented.mining_pool.license != candidate.mining_pool.license
        || consented.pool_adapter.license != candidate.pool_adapter.license
    {
        changes.push(MaterialPoolOfferChange::LicenseTerms);
    }
    if changes.is_empty() {
        return Ok(PoolOfferChange::Equivalent);
    }
    Ok(PoolOfferChange::MateriallyChanged {
        changes: MaterialPoolOfferChanges(changes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{pool_offer::ApprovedBeneficiary, web_url::HttpsUrl};

    #[test]
    fn endpoint_failover_with_the_same_terms_is_equivalent() -> Result<(), PoolOfferError> {
        // Arrange
        let consented = super::super::default_pool_offer(
            "https://authority.example/privacy",
            "https://authority.example/terms",
        )?;
        let mut candidate = consented.clone();
        candidate.endpoint = "stratum+tcp://failover.example:3333/".to_owned();

        // Act / Assert
        assert_eq!(
            classify_pool_offer_change(&consented, &candidate)?,
            PoolOfferChange::Equivalent
        );
        Ok(())
    }

    #[test]
    fn every_consent_relevant_change_is_classified_in_stable_order() -> Result<(), PoolOfferError> {
        // Arrange
        let consented = super::super::default_pool_offer(
            "https://authority.example/privacy",
            "https://authority.example/terms",
        )?;
        let mut candidate = consented.clone();
        candidate.reward_policy.selected_destination_basis_points = 9_900;
        candidate.reward_policy.pool_fee_basis_points = 100;
        candidate
            .payout_requirements
            .approved_beneficiaries
            .push(ApprovedBeneficiary {
                beneficiary_id: "approved_beneficiary".to_owned(),
                display_name: "Approved beneficiary".to_owned(),
                terms_url: HttpsUrl::try_from(
                    "https://authority.example/beneficiary-terms".to_owned(),
                )?,
            });
        candidate.privacy_terms_url =
            HttpsUrl::try_from("https://authority.example/privacy-v2".to_owned())?;
        candidate.operator_terms_url =
            HttpsUrl::try_from("https://authority.example/terms-v2".to_owned())?;
        candidate.pool_adapter.license = "Apache-2.0".to_owned();

        // Act
        let result = classify_pool_offer_change(&consented, &candidate)?;

        // Assert
        assert!(matches!(
            result,
            PoolOfferChange::MateriallyChanged { ref changes }
                if changes.as_slice() == [
                    MaterialPoolOfferChange::EconomicTerms,
                    MaterialPoolOfferChange::PayoutTerms,
                    MaterialPoolOfferChange::PrivacyTerms,
                    MaterialPoolOfferChange::OperatorTerms,
                    MaterialPoolOfferChange::LicenseTerms,
                ]
        ));
        Ok(())
    }
}
