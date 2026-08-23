use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::crypto_profile::{AuthorityJwk, verify_dpop, verify_gate_pass};

const DPOP_FRESHNESS_WINDOW_SECONDS: u64 = 60;

pub(crate) struct RedemptionBindingInput<'a> {
    pub trusted_issuer: &'a str,
    pub expected_audience: &'a str,
    pub expected_action_reference: &'a str,
    pub redemption_url: &'a str,
    pub now: u64,
    pub gate_pass_issuer: &'a str,
    pub gate_pass_audience: &'a str,
    pub gate_pass_action_reference: &'a str,
    pub gate_pass_claimant_jkt: &'a str,
    pub gate_pass_issued_at: u64,
    pub gate_pass_expires_at: u64,
    pub dpop_claimant_jkt: &'a str,
    pub dpop_method: &'a str,
    pub dpop_uri: &'a str,
    pub dpop_issued_at: u64,
}

pub(crate) fn validate_redemption_binding(
    input: RedemptionBindingInput<'_>,
) -> Result<(), RedemptionError> {
    if input.gate_pass_issuer != input.trusted_issuer {
        return Err(RedemptionError::WrongIssuer);
    }
    if input.gate_pass_audience != input.expected_audience {
        return Err(RedemptionError::WrongAudience);
    }
    if input.gate_pass_action_reference != input.expected_action_reference {
        return Err(RedemptionError::WrongActionReference);
    }
    if input.dpop_claimant_jkt != input.gate_pass_claimant_jkt {
        return Err(RedemptionError::WrongClaimantKey);
    }
    if input.dpop_method != "POST" || input.dpop_uri != input.redemption_url {
        return Err(RedemptionError::WrongDpopRequest);
    }
    if input.now.abs_diff(input.dpop_issued_at) > DPOP_FRESHNESS_WINDOW_SECONDS {
        return Err(RedemptionError::StaleDpopProof);
    }
    if input.now < input.gate_pass_issued_at || input.now >= input.gate_pass_expires_at {
        return Err(RedemptionError::ExpiredGatePass);
    }
    Ok(())
}

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
    pub redemption_id: String,
    pub action_reference: String,
    pub accepted_at_unix_seconds: u64,
    pub outcome: ProtectedActionOutcome,
}

/// Claimant-visible durable execution state linked to one Redemption Record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ProtectedActionOutcome {
    Pending,
    Succeeded { result: ProtectedActionResult },
    Failed { reason: String },
}

/// Safe successful result for the reference account-creation action.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct ProtectedActionResult {
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
        let dpop = verify_dpop(&request.dpop_proof, &request.gate_pass)?;
        validate_redemption_binding(RedemptionBindingInput {
            trusted_issuer: &self.trusted_issuer,
            expected_audience: &self.audience,
            expected_action_reference: &request.action_reference,
            redemption_url: &self.redemption_url,
            now,
            gate_pass_issuer: gate_pass.issuer(),
            gate_pass_audience: gate_pass.audience(),
            gate_pass_action_reference: gate_pass.action_reference(),
            gate_pass_claimant_jkt: gate_pass.claimant_jkt(),
            gate_pass_issued_at: gate_pass.issued_at(),
            gate_pass_expires_at: gate_pass.expires_at(),
            dpop_claimant_jkt: dpop.claimant_jkt(),
            dpop_method: dpop.http_method(),
            dpop_uri: dpop.http_uri(),
            dpop_issued_at: dpop.issued_at(),
        })?;

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
        let record = RedemptionRecord {
            redemption_id: format!("redemption_{}", Uuid::new_v4().simple()),
            action_reference: request.action_reference,
            accepted_at_unix_seconds: now,
            outcome: ProtectedActionOutcome::Succeeded {
                result: ProtectedActionResult {
                    account_id: format!("account_{}", Uuid::new_v4().simple()),
                },
            },
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

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_binding() -> RedemptionBindingInput<'static> {
        RedemptionBindingInput {
            trusted_issuer: "https://authority.example",
            expected_audience: "https://relying.example",
            expected_action_reference: "action_test_01",
            redemption_url: "https://relying.example/redeem",
            now: 100,
            gate_pass_issuer: "https://authority.example",
            gate_pass_audience: "https://relying.example",
            gate_pass_action_reference: "action_test_01",
            gate_pass_claimant_jkt: "claimant_key_01",
            gate_pass_issued_at: 90,
            gate_pass_expires_at: 120,
            dpop_claimant_jkt: "claimant_key_01",
            dpop_method: "POST",
            dpop_uri: "https://relying.example/redeem",
            dpop_issued_at: 100,
        }
    }

    #[test]
    fn valid_redemption_binding_is_accepted() {
        // Arrange
        let input = valid_binding();

        // Act
        let result = validate_redemption_binding(input);

        // Assert
        assert!(result.is_ok());
    }

    #[test]
    fn redemption_binding_rejects_wrong_claimant() {
        // Arrange
        let mut input = valid_binding();
        input.dpop_claimant_jkt = "different_key";

        // Act
        let result = validate_redemption_binding(input);

        // Assert
        assert!(matches!(result, Err(RedemptionError::WrongClaimantKey)));
    }

    #[test]
    fn redemption_binding_rejects_wrong_issuer() {
        // Arrange
        let mut input = valid_binding();
        input.gate_pass_issuer = "https://other-authority.example";

        // Act
        let result = validate_redemption_binding(input);

        // Assert
        assert!(matches!(result, Err(RedemptionError::WrongIssuer)));
    }

    #[test]
    fn redemption_binding_rejects_wrong_audience() {
        // Arrange
        let mut input = valid_binding();
        input.gate_pass_audience = "https://other-relying.example";

        // Act
        let result = validate_redemption_binding(input);

        // Assert
        assert!(matches!(result, Err(RedemptionError::WrongAudience)));
    }

    #[test]
    fn redemption_binding_rejects_wrong_action_reference() {
        // Arrange
        let mut input = valid_binding();
        input.gate_pass_action_reference = "action_other_01";

        // Act
        let result = validate_redemption_binding(input);

        // Assert
        assert!(matches!(result, Err(RedemptionError::WrongActionReference)));
    }

    #[test]
    fn redemption_binding_rejects_wrong_http_request() {
        // Arrange
        let mut input = valid_binding();
        input.dpop_method = "GET";

        // Act
        let result = validate_redemption_binding(input);

        // Assert
        assert!(matches!(result, Err(RedemptionError::WrongDpopRequest)));
    }

    #[test]
    fn redemption_binding_rejects_wrong_http_uri() {
        // Arrange
        let mut input = valid_binding();
        input.dpop_uri = "https://relying.example/other";

        // Act
        let result = validate_redemption_binding(input);

        // Assert
        assert!(matches!(result, Err(RedemptionError::WrongDpopRequest)));
    }

    #[test]
    fn redemption_binding_rejects_stale_proof() {
        // Arrange
        let mut input = valid_binding();
        input.dpop_issued_at = 39;

        // Act
        let result = validate_redemption_binding(input);

        // Assert
        assert!(matches!(result, Err(RedemptionError::StaleDpopProof)));
    }

    #[test]
    fn redemption_binding_rejects_expired_pass() {
        // Arrange
        let mut input = valid_binding();
        input.gate_pass_expires_at = 100;

        // Act
        let result = validate_redemption_binding(input);

        // Assert
        assert!(matches!(result, Err(RedemptionError::ExpiredGatePass)));
    }

    #[test]
    fn redemption_binding_rejects_not_yet_valid_pass() {
        // Arrange
        let mut input = valid_binding();
        input.gate_pass_issued_at = 101;

        // Act
        let result = validate_redemption_binding(input);

        // Assert
        assert!(matches!(result, Err(RedemptionError::ExpiredGatePass)));
    }
}
