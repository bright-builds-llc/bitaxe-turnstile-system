use super::{
    ActionPolicy, AuthoritySigningKey, POOL_OFFER_SET_TYPE, PROTOCOL_VERSION, PoolOffer,
    PoolOfferChange, PoolOfferError, PoolOfferSetClaims, SignedPoolOfferSet, validate_claims,
};
use crate::progress::WorkSessionId;
use serde::{Deserialize, Serialize};

#[cfg(test)]
mod tests;

/// Durable release state for one authenticated replacement-offer decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PoolOfferReplacementStatus {
    Equivalent,
    PendingReconfirmation,
}

/// Immutable Authority decision comparing consented and candidate Pool Offer terms.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolOfferReplacementDecision {
    replaced_session_id: WorkSessionId,
    maybe_replacement_session_id: Option<WorkSessionId>,
    status: PoolOfferReplacementStatus,
    prior_offer: PoolOffer,
    candidate_offer: PoolOffer,
    candidate_signature: String,
    change: PoolOfferChange,
}

impl PoolOfferReplacementDecision {
    pub(crate) fn persisted(
        replaced_session_id: WorkSessionId,
        maybe_replacement_session_id: Option<WorkSessionId>,
        prior_offer: PoolOffer,
        candidate_offer: PoolOffer,
        candidate_signature: String,
        change: PoolOfferChange,
    ) -> Result<Self, PoolOfferError> {
        let status = match &change {
            PoolOfferChange::Equivalent => PoolOfferReplacementStatus::Equivalent,
            PoolOfferChange::MateriallyChanged { .. } => {
                PoolOfferReplacementStatus::PendingReconfirmation
            }
        };
        if candidate_signature.is_empty()
            || (status == PoolOfferReplacementStatus::Equivalent)
                != maybe_replacement_session_id.is_some()
        {
            return Err(PoolOfferError::InvalidPoolOffer);
        }
        Ok(Self {
            replaced_session_id,
            maybe_replacement_session_id,
            status,
            prior_offer,
            candidate_offer,
            candidate_signature,
            change,
        })
    }

    pub fn status(&self) -> PoolOfferReplacementStatus {
        self.status
    }
    pub fn maybe_replacement_session_id(&self) -> Option<&WorkSessionId> {
        self.maybe_replacement_session_id.as_ref()
    }
    pub fn replaced_session_id(&self) -> &WorkSessionId {
        &self.replaced_session_id
    }
    pub fn prior_offer(&self) -> &PoolOffer {
        &self.prior_offer
    }
    pub fn candidate_offer(&self) -> &PoolOffer {
        &self.candidate_offer
    }
    pub fn candidate_signature(&self) -> &str {
        &self.candidate_signature
    }
    pub fn change(&self) -> &PoolOfferChange {
        &self.change
    }
}

pub(crate) fn signed_pool_offers(
    signer: &AuthoritySigningKey,
    issuer: &str,
    challenge_id: &str,
    action_policy: ActionPolicy,
    offers: Vec<PoolOffer>,
    trusted_confirmation_required: bool,
) -> Result<SignedPoolOfferSet, PoolOfferError> {
    let claims = PoolOfferSetClaims {
        iss: issuer.to_owned(),
        challenge_id: challenge_id.to_owned(),
        action_policy: action_policy.id().to_owned(),
        offers: offers.clone(),
        trusted_confirmation_required,
        bwg_version: PROTOCOL_VERSION.to_owned(),
    };
    validate_claims(&claims)?;
    let signature = signer.sign_authority_payload(POOL_OFFER_SET_TYPE, &claims)?;
    Ok(SignedPoolOfferSet { offers, signature })
}
