use std::sync::{Arc, Mutex};

use thiserror::Error;
use uuid::Uuid;

use crate::{
    challenge::{ChallengeId, WorkChallengeDescriptor},
    crypto_profile::{
        AuthoritySigningKey, GatePassClaimsInput, GatePassConfirmationInput, P256PublicJwk,
        P256PublicJwkWire, p256_jwk_thumbprint,
    },
};

const GATE_PASS_TTL_SECONDS: u64 = 2 * 60;

/// Exactly-once intent created when a Work Challenge first reaches its threshold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatePassIssuanceIntent {
    pub pass_id: String,
    pub challenge_id: String,
    pub issued_at: u64,
    pub expires_at: u64,
}

#[derive(Clone)]
pub(crate) struct GatePassIssuer {
    issuer: String,
    state: Arc<Mutex<GatePassIssuerState>>,
}

#[derive(Default)]
struct GatePassIssuerState {
    maybe_signer: Option<AuthoritySigningKey>,
    challenges: std::collections::HashMap<ChallengeId, StoredChallenge>,
}

struct StoredChallenge {
    audience: String,
    action_reference: String,
    claimant_key: String,
    maybe_intent: Option<GatePassIssuanceIntent>,
    maybe_gate_pass: Option<String>,
}

impl GatePassIssuer {
    pub(crate) fn new(issuer: String) -> Self {
        Self {
            issuer,
            state: Arc::new(Mutex::new(GatePassIssuerState::default())),
        }
    }

    pub(crate) fn set_signer(
        &self,
        signer: AuthoritySigningKey,
    ) -> Result<(), GatePassIssuerError> {
        self.lock_state()?.maybe_signer = Some(signer);
        Ok(())
    }

    pub(crate) fn register_challenge(
        &self,
        descriptor: &WorkChallengeDescriptor,
    ) -> Result<(), GatePassIssuerError> {
        let challenge_id = ChallengeId::try_from(descriptor.challenge_id().to_owned())?;
        let mut state = self.lock_state()?;
        if state.challenges.contains_key(&challenge_id) {
            return Err(GatePassIssuerError::DuplicateChallenge);
        }
        state.challenges.insert(
            challenge_id,
            StoredChallenge {
                audience: descriptor.relying_service_audience().to_owned(),
                action_reference: descriptor.action_reference().to_owned(),
                claimant_key: descriptor.claimant_key().to_owned(),
                maybe_intent: None,
                maybe_gate_pass: None,
            },
        );
        Ok(())
    }

    pub(crate) fn ensure_issued(
        &self,
        challenge_id: &ChallengeId,
        issued_at: u64,
    ) -> Result<String, GatePassIssuerError> {
        let mut state = self.lock_state()?;
        let signer = state
            .maybe_signer
            .clone()
            .ok_or(GatePassIssuerError::SigningUnavailable)?;
        let challenge = state
            .challenges
            .get_mut(challenge_id)
            .ok_or(GatePassIssuerError::UnknownChallenge)?;
        if let Some(gate_pass) = &challenge.maybe_gate_pass {
            return Ok(gate_pass.clone());
        }
        if challenge.maybe_intent.is_none() {
            let expires_at = issued_at
                .checked_add(GATE_PASS_TTL_SECONDS)
                .ok_or(GatePassIssuerError::TimeOverflow)?;
            challenge.maybe_intent = Some(GatePassIssuanceIntent {
                pass_id: format!("pass_{}", Uuid::new_v4().simple()),
                challenge_id: challenge_id.as_str().to_owned(),
                issued_at,
                expires_at,
            });
        }
        let intent = challenge
            .maybe_intent
            .as_ref()
            .ok_or(GatePassIssuerError::IssuanceIntentUnavailable)?;
        let claimant_wire = serde_json::from_str::<P256PublicJwkWire>(&challenge.claimant_key)
            .map_err(|_| GatePassIssuerError::InvalidClaimantKey)?;
        let claimant_key = P256PublicJwk::try_from(claimant_wire)
            .map_err(|_| GatePassIssuerError::InvalidClaimantKey)?;
        let claims = GatePassClaimsInput {
            iss: self.issuer.clone(),
            aud: challenge.audience.clone(),
            iat: intent.issued_at,
            exp: intent.expires_at,
            jti: intent.pass_id.clone(),
            challenge_id: intent.challenge_id.clone(),
            action_reference: challenge.action_reference.clone(),
            cnf: GatePassConfirmationInput {
                jkt: p256_jwk_thumbprint(&claimant_key),
            },
            bwg_version: "BWG/0.1".to_owned(),
        };
        let gate_pass = signer.sign_gate_pass(&claims)?;
        challenge.maybe_gate_pass = Some(gate_pass.clone());
        Ok(gate_pass)
    }

    pub(crate) fn maybe_gate_pass(
        &self,
        challenge_id: &ChallengeId,
    ) -> Result<Option<String>, GatePassIssuerError> {
        Ok(self
            .lock_state()?
            .challenges
            .get(challenge_id)
            .ok_or(GatePassIssuerError::UnknownChallenge)?
            .maybe_gate_pass
            .clone())
    }

    fn lock_state(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, GatePassIssuerState>, GatePassIssuerError> {
        self.state
            .lock()
            .map_err(|_| GatePassIssuerError::StateUnavailable)
    }
}

#[derive(Debug, Error)]
pub enum GatePassIssuerError {
    #[error("Gate Pass issuer state is unavailable")]
    StateUnavailable,
    #[error("Work Challenge is already registered for Gate Pass issuance")]
    DuplicateChallenge,
    #[error("Work Challenge is unknown to Gate Pass issuance")]
    UnknownChallenge,
    #[error("Gate Pass signing key is unavailable")]
    SigningUnavailable,
    #[error("Claimant key is not a valid P-256 public JWK")]
    InvalidClaimantKey,
    #[error("Gate Pass time overflow")]
    TimeOverflow,
    #[error("Gate Pass issuance intent is unavailable")]
    IssuanceIntentUnavailable,
    #[error(transparent)]
    InvalidChallenge(#[from] crate::challenge::ChallengeError),
    #[error(transparent)]
    Crypto(#[from] crate::crypto_profile::CryptoProfileError),
}
