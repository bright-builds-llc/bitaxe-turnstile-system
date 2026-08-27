use super::{
    ActionPolicy, AuthoritySigningKey, POOL_OFFER_SET_TYPE, PROTOCOL_VERSION, PoolOffer,
    PoolOfferChange, PoolOfferError, PoolOfferSetClaims, SignedPoolOfferSet, validate_claims,
};
use crate::progress::WorkSessionId;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::digest;
use serde::{Deserialize, Serialize};

#[cfg(test)]
mod tests;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub(crate) struct Sha256Base64Url(String);

impl TryFrom<String> for Sha256Base64Url {
    type Error = PoolOfferError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.len() != 43
            || !URL_SAFE_NO_PAD
                .decode(value.as_bytes())
                .is_ok_and(|bytes| bytes.len() == 32)
        {
            return Err(PoolOfferError::InvalidPoolOffer);
        }
        Ok(Self(value))
    }
}

impl<'de> Deserialize<'de> for Sha256Base64Url {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::try_from(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

impl Sha256Base64Url {
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaterialPoolOfferConfirmation {
    replaced_session_id: WorkSessionId,
    candidate_session_id: WorkSessionId,
    signed_pool_offers: SignedPoolOfferSet,
    disclosure_digest_sha256: Sha256Base64Url,
}

impl MaterialPoolOfferConfirmation {
    pub(crate) fn persisted(
        replaced_session_id: WorkSessionId,
        candidate_session_id: WorkSessionId,
        signed_pool_offers: SignedPoolOfferSet,
        disclosure_digest_sha256: Sha256Base64Url,
    ) -> Result<Self, PoolOfferError> {
        signed_pool_offers.validate_shape()?;
        Ok(Self {
            replaced_session_id,
            candidate_session_id,
            signed_pool_offers,
            disclosure_digest_sha256,
        })
    }

    pub fn signed_pool_offers(&self) -> &SignedPoolOfferSet {
        &self.signed_pool_offers
    }
    pub fn disclosure_digest_sha256(&self) -> &str {
        self.disclosure_digest_sha256.as_str()
    }
    pub(crate) fn replaced_session_id(&self) -> &WorkSessionId {
        &self.replaced_session_id
    }

    pub(crate) fn signature_digest_sha256(&self) -> Sha256Base64Url {
        Sha256Base64Url(URL_SAFE_NO_PAD.encode(digest::digest(
            &digest::SHA256,
            self.signed_pool_offers.signature().as_bytes(),
        )))
    }
}

pub(crate) fn material_replacement_disclosure_digest(
    replaced_session_id: &WorkSessionId,
    candidate_session_id: &WorkSessionId,
    prior_offer: &PoolOffer,
    candidate_offer: &PoolOffer,
    change: &PoolOfferChange,
) -> Result<Sha256Base64Url, PoolOfferError> {
    let bytes = serde_json::to_vec(&serde_json::json!({
        "replaced_session_id": replaced_session_id.as_str(),
        "candidate_session_id": candidate_session_id.as_str(),
        "prior_offer": prior_offer,
        "candidate_offer": candidate_offer,
        "change": change,
    }))
    .map_err(|_| PoolOfferError::InvalidPoolOffer)?;
    Sha256Base64Url::try_from(URL_SAFE_NO_PAD.encode(digest::digest(&digest::SHA256, &bytes)))
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
    maybe_material_replacement_digest_sha256: Option<Sha256Base64Url>,
) -> Result<SignedPoolOfferSet, PoolOfferError> {
    let claims = PoolOfferSetClaims {
        iss: issuer.to_owned(),
        challenge_id: challenge_id.to_owned(),
        action_policy: action_policy.id().to_owned(),
        offers: offers.clone(),
        trusted_confirmation_required,
        material_replacement_digest_sha256: maybe_material_replacement_digest_sha256,
        bwg_version: PROTOCOL_VERSION.to_owned(),
    };
    validate_claims(&claims)?;
    let signature = signer.sign_authority_payload(POOL_OFFER_SET_TYPE, &claims)?;
    Ok(SignedPoolOfferSet { offers, signature })
}

pub(crate) fn signed_default_pool_offers(
    signer: &AuthoritySigningKey,
    issuer: &str,
    challenge_id: &str,
    action_policy: ActionPolicy,
    privacy_terms_url: &str,
    operator_terms_url: &str,
) -> Result<SignedPoolOfferSet, PoolOfferError> {
    let offers = vec![super::default_pool_offer(
        privacy_terms_url,
        operator_terms_url,
    )?];
    signed_pool_offers(
        signer,
        issuer,
        challenge_id,
        action_policy,
        offers,
        action_policy.requires_trusted_confirmation(),
        None,
    )
}
