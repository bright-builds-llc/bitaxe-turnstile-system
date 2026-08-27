use super::{
    ActionPolicy, AuthoritySigningKey, POOL_OFFER_SET_TYPE, PROTOCOL_VERSION, PoolOffer,
    PoolOfferChange, PoolOfferError, PoolOfferSetClaims, SignedPoolOfferSet, validate_claims,
};
use crate::{
    challenge::ChallengeId,
    lifecycle::{SessionLifecycleState, SessionStopReason},
    progress::WorkSessionId,
};
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

/// Safe Pool Adapter recovery category for one authenticated offer replacement.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PoolFailoverRecoveryCategory {
    AutomaticEquivalent,
    TrustedConfirmationRequired,
    TrustedConfirmationAccepted,
}

/// Redacted per-session state used by the Pool Adapter failover projection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PoolFailoverSessionState {
    Ready,
    Leased,
    Stopping,
    Restored,
    Failed,
    PendingConfirmation,
}

impl From<SessionLifecycleState> for PoolFailoverSessionState {
    fn from(value: SessionLifecycleState) -> Self {
        match value {
            SessionLifecycleState::Ready => Self::Ready,
            SessionLifecycleState::Leased => Self::Leased,
            SessionLifecycleState::Stopping => Self::Stopping,
            SessionLifecycleState::Restored => Self::Restored,
            SessionLifecycleState::Failed => Self::Failed,
        }
    }
}

/// Metadata-only state for one opaque Work Session in a failover transition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PoolFailoverSessionProjection {
    session_id: WorkSessionId,
    state: PoolFailoverSessionState,
    #[serde(rename = "stop_reason", skip_serializing_if = "Option::is_none")]
    maybe_stop_reason: Option<String>,
}

impl PoolFailoverSessionProjection {
    fn persisted(
        session_id: WorkSessionId,
        state: SessionLifecycleState,
        maybe_stop_reason: Option<SessionStopReason>,
    ) -> Result<Self, PoolOfferError> {
        let reason_required = matches!(
            state,
            SessionLifecycleState::Stopping
                | SessionLifecycleState::Restored
                | SessionLifecycleState::Failed
        );
        if reason_required != maybe_stop_reason.is_some() {
            return Err(PoolOfferError::InvalidPoolOffer);
        }
        Ok(Self {
            session_id,
            state: state.into(),
            maybe_stop_reason: maybe_stop_reason.map(|reason| reason.as_str().to_owned()),
        })
    }

    fn pending(session_id: WorkSessionId) -> Self {
        Self {
            session_id,
            state: PoolFailoverSessionState::PendingConfirmation,
            maybe_stop_reason: None,
        }
    }

    /// Opaque session-scoped operational identifier; never a Worker or Device identity.
    pub fn session_id(&self) -> &WorkSessionId {
        &self.session_id
    }

    /// Current safe lifecycle category.
    pub fn state(&self) -> PoolFailoverSessionState {
        self.state
    }

    /// Authority-derived stop reason, when this session is no longer active.
    pub fn maybe_stop_reason(&self) -> Option<&str> {
        self.maybe_stop_reason.as_deref()
    }
}

/// Restart-safe Pool Adapter projection of one authenticated failover decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PoolFailoverProjection {
    challenge_id: ChallengeId,
    predecessor_session: PoolFailoverSessionProjection,
    candidate_session: PoolFailoverSessionProjection,
    current_offer: PoolOffer,
    #[serde(rename = "pending_offer", skip_serializing_if = "Option::is_none")]
    maybe_pending_offer: Option<PoolOffer>,
    recovery_category: PoolFailoverRecoveryCategory,
}

pub(crate) struct PersistedPoolFailoverProjection {
    pub challenge_id: ChallengeId,
    pub predecessor_session_id: WorkSessionId,
    pub candidate_session_id: WorkSessionId,
    pub replacement_status: PoolOfferReplacementStatus,
    pub prior_offer: PoolOffer,
    pub candidate_offer: PoolOffer,
    pub predecessor_state: SessionLifecycleState,
    pub maybe_predecessor_stop_reason: Option<SessionStopReason>,
    pub maybe_candidate_state: Option<SessionLifecycleState>,
    pub maybe_candidate_stop_reason: Option<SessionStopReason>,
}

impl PoolFailoverProjection {
    pub(crate) fn persisted(
        input: PersistedPoolFailoverProjection,
    ) -> Result<Self, PoolOfferError> {
        let predecessor_session = PoolFailoverSessionProjection::persisted(
            input.predecessor_session_id,
            input.predecessor_state,
            input.maybe_predecessor_stop_reason,
        )?;
        let maybe_candidate_session = input
            .maybe_candidate_state
            .map(|state| {
                PoolFailoverSessionProjection::persisted(
                    input.candidate_session_id.clone(),
                    state,
                    input.maybe_candidate_stop_reason,
                )
            })
            .transpose()?;
        let (candidate_session, current_offer, maybe_pending_offer, recovery_category) =
            match (input.replacement_status, maybe_candidate_session) {
                (PoolOfferReplacementStatus::Equivalent, Some(candidate)) => (
                    candidate,
                    input.candidate_offer,
                    None,
                    PoolFailoverRecoveryCategory::AutomaticEquivalent,
                ),
                (PoolOfferReplacementStatus::PendingReconfirmation, None) => (
                    PoolFailoverSessionProjection::pending(input.candidate_session_id),
                    input.prior_offer,
                    Some(input.candidate_offer),
                    PoolFailoverRecoveryCategory::TrustedConfirmationRequired,
                ),
                (PoolOfferReplacementStatus::PendingReconfirmation, Some(candidate)) => (
                    candidate,
                    input.candidate_offer,
                    None,
                    PoolFailoverRecoveryCategory::TrustedConfirmationAccepted,
                ),
                (PoolOfferReplacementStatus::Equivalent, None) => {
                    return Err(PoolOfferError::InvalidPoolOffer);
                }
            };
        Ok(Self {
            challenge_id: input.challenge_id,
            predecessor_session,
            candidate_session,
            current_offer,
            maybe_pending_offer,
            recovery_category,
        })
    }

    /// Challenge whose consent and exact progress own this failover.
    pub fn challenge_id(&self) -> &ChallengeId {
        &self.challenge_id
    }

    /// Stopped session that triggered recovery.
    pub fn predecessor_session(&self) -> &PoolFailoverSessionProjection {
        &self.predecessor_session
    }

    /// Candidate session, including the pre-release pending-confirmation state.
    pub fn candidate_session(&self) -> &PoolFailoverSessionProjection {
        &self.candidate_session
    }

    /// Exact authenticated offer currently authorized for this transition.
    pub fn current_offer(&self) -> &PoolOffer {
        &self.current_offer
    }

    /// Exact authenticated candidate held pending fresh confirmation, when present.
    pub fn maybe_pending_offer(&self) -> Option<&PoolOffer> {
        self.maybe_pending_offer.as_ref()
    }

    /// Stable operator recovery category without Worker or credential identity.
    pub fn recovery_category(&self) -> PoolFailoverRecoveryCategory {
        self.recovery_category
    }
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
