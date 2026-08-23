use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::crypto_profile::{AuthorityJwk, verify_dpop, verify_gate_pass};

const DPOP_FRESHNESS_WINDOW_SECONDS: u64 = 60;

/// Public Redemption request carrying a Gate Pass and Claimant DPoP proof.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RedemptionRequest {
    pub gate_pass: String,
    pub dpop_proof: String,
    pub action_reference: String,
}

/// Durable idempotent outcome of the one protected reference action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RedemptionRecord {
    pub pass_id: String,
    pub action_reference: String,
    pub account_id: String,
}

#[derive(Clone)]
pub struct RedemptionService {
    trusted_issuer: String,
    trusted_keys: Arc<[AuthorityJwk]>,
    audience: String,
    redemption_url: String,
    state: Arc<Mutex<RedemptionState>>,
}

#[derive(Default)]
struct RedemptionState {
    records: HashMap<String, RedemptionRecord>,
    dpop_proof_ids: HashSet<String>,
}

impl RedemptionService {
    /// Creates an atomic Redemption service from separately trusted configuration.
    pub fn new(
        trusted_issuer: String,
        trusted_keys: Vec<AuthorityJwk>,
        audience: String,
        redemption_url: String,
    ) -> Self {
        Self {
            trusted_issuer,
            trusted_keys: trusted_keys.into(),
            audience,
            redemption_url,
            state: Arc::new(Mutex::new(RedemptionState::default())),
        }
    }

    /// Verifies and consumes a pass, or retrieves its already accepted outcome idempotently.
    pub fn redeem(
        &self,
        request: RedemptionRequest,
        now: u64,
    ) -> Result<RedemptionRecord, RedemptionError> {
        let gate_pass = verify_gate_pass(&request.gate_pass, &self.trusted_keys)?;
        if gate_pass.issuer() != self.trusted_issuer {
            return Err(RedemptionError::WrongIssuer);
        }
        if gate_pass.audience() != self.audience {
            return Err(RedemptionError::WrongAudience);
        }
        if gate_pass.action_reference() != request.action_reference {
            return Err(RedemptionError::WrongActionReference);
        }

        let dpop = verify_dpop(&request.dpop_proof, &request.gate_pass)?;
        if dpop.claimant_jkt() != gate_pass.claimant_jkt() {
            return Err(RedemptionError::WrongClaimantKey);
        }
        if dpop.http_method() != "POST" || dpop.http_uri() != self.redemption_url {
            return Err(RedemptionError::WrongDpopRequest);
        }
        if now.abs_diff(dpop.issued_at()) > DPOP_FRESHNESS_WINDOW_SECONDS {
            return Err(RedemptionError::StaleDpopProof);
        }

        let mut state = self
            .state
            .lock()
            .map_err(|_| RedemptionError::StateUnavailable)?;
        if state.dpop_proof_ids.contains(dpop.proof_id()) {
            return Err(RedemptionError::ReplayedDpopProof);
        }
        if let Some(record) = state.records.get(gate_pass.pass_id()).cloned() {
            state.dpop_proof_ids.insert(dpop.proof_id().to_owned());
            return Ok(record);
        }
        if now < gate_pass.issued_at() || now >= gate_pass.expires_at() {
            return Err(RedemptionError::ExpiredGatePass);
        }

        let record = RedemptionRecord {
            pass_id: gate_pass.pass_id().to_owned(),
            action_reference: request.action_reference,
            account_id: format!("account_{}", Uuid::new_v4().simple()),
        };
        state.dpop_proof_ids.insert(dpop.proof_id().to_owned());
        state
            .records
            .insert(gate_pass.pass_id().to_owned(), record.clone());
        Ok(record)
    }
}

#[derive(Debug, Error)]
pub enum RedemptionError {
    #[error("trusted Authority issuer does not match")]
    WrongIssuer,
    #[error("Gate Pass audience does not match")]
    WrongAudience,
    #[error("Gate Pass Action Reference does not match")]
    WrongActionReference,
    #[error("DPoP key does not match Gate Pass confirmation")]
    WrongClaimantKey,
    #[error("DPoP method or URI does not match Redemption")]
    WrongDpopRequest,
    #[error("DPoP proof is outside the freshness window")]
    StaleDpopProof,
    #[error("DPoP proof identity was already used")]
    ReplayedDpopProof,
    #[error("Gate Pass is expired or not yet valid")]
    ExpiredGatePass,
    #[error("Redemption state is unavailable")]
    StateUnavailable,
    #[error(transparent)]
    Crypto(#[from] crate::crypto_profile::CryptoProfileError),
}
