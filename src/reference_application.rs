use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use thiserror::Error;

use crate::{
    challenge::ActionPolicy,
    crypto_profile::{
        AuthorityJwk, AuthorityKeySet, CryptoProfileError, P256PublicJwk, P256PublicJwkWire,
        p256_jwk_thumbprint, verify_dpop, verify_gate_pass, verify_outcome_proof,
    },
    redemption::{
        RedemptionBindingInput, RedemptionRecord, RedemptionRequest, validate_redemption_binding,
    },
    reference_persistence::{
        NewProtectedAction, PostgresReferenceRepository, ReferencePersistenceError,
        ReferenceRepository, ValidatedRedemption,
    },
    reference_service::{AccountCreationExecutor, Config},
};

const ACTION_EXECUTION_TIMEOUT_SECONDS: u64 = 5 * 60;
const ACTION_MAXIMUM_ATTEMPTS: u32 = 3;
const RETRYABLE_ERROR_CLASSES: [&str; 1] = ["transient"];
const DPOP_FRESHNESS_WINDOW_SECONDS: u64 = 60;
const ACTION_LEASE_SECONDS: u64 = 30;
const MAXIMUM_WORKER_ID_LENGTH: usize = 128;
const OUTCOME_PROOF_FRESHNESS_SECONDS: u64 = 60;

/// PostgreSQL-backed Reference Relying Service application module.
#[derive(Clone)]
pub struct ReferenceApplication {
    pub(crate) config: Config,
    repository: Arc<dyn ReferenceRepository>,
    trusted_authority_keys: Arc<[AuthorityJwk]>,
}

impl ReferenceApplication {
    /// Connects the Reference Service to its isolated PostgreSQL schema.
    pub async fn connect_postgres(
        config: Config,
        database_url: &str,
    ) -> Result<Self, ReferenceApplicationError> {
        let repository = PostgresReferenceRepository::connect(database_url).await?;
        repository
            .replace_trusted_authority_keys(
                config.trusted_authority().issuer(),
                &config.trusted_authority().key_wires(),
            )
            .await?;
        let trusted_authority_keys = AuthorityKeySet::try_from(
            repository
                .trusted_authority_keys(config.trusted_authority().issuer())
                .await?,
        )
        .map_err(|_| ReferenceApplicationError::InvalidTrustedAuthorityKeys)?;
        Ok(Self {
            config,
            repository: Arc::new(repository),
            trusted_authority_keys: trusted_authority_keys.keys().to_vec().into(),
        })
    }

    pub(crate) async fn insert_protected_action(
        &self,
        action_reference: &str,
        claimant_key: &str,
        now: u64,
    ) -> Result<(), ReferenceApplicationError> {
        let claimant_wire = serde_json::from_str::<P256PublicJwkWire>(claimant_key)
            .map_err(|_| ReferenceApplicationError::InvalidClaimantKey)?;
        let claimant_key = P256PublicJwk::try_from(claimant_wire)
            .map_err(|_| ReferenceApplicationError::InvalidClaimantKey)?;
        let claimant_jkt = p256_jwk_thumbprint(&claimant_key);
        let policy = ActionPolicy::AccountCreationStandardV1;
        self.repository
            .insert_protected_action(NewProtectedAction {
                audience: self.config.relying_service_audience(),
                action_reference,
                claimant_jkt: &claimant_jkt,
                protected_action_type: policy.protected_action_type().id(),
                action_policy: policy.id(),
                execution_timeout_seconds: ACTION_EXECUTION_TIMEOUT_SECONDS,
                maximum_attempts: ACTION_MAXIMUM_ATTEMPTS,
                retryable_error_classes: &RETRYABLE_ERROR_CLASSES,
                created_at_unix_seconds: now,
            })
            .await?;
        Ok(())
    }

    pub(crate) async fn redeem(
        &self,
        request: RedemptionRequest,
        now: u64,
    ) -> Result<RedemptionRecord, ReferenceApplicationError> {
        let gate_pass = verify_gate_pass(&request.gate_pass, &self.trusted_authority_keys)?;
        let dpop = verify_dpop(&request.dpop_proof, &request.gate_pass)?;
        validate_redemption_binding(RedemptionBindingInput {
            trusted_issuer: self.config.trusted_authority().issuer(),
            expected_audience: self.config.relying_service_audience(),
            expected_action_reference: &request.action_reference,
            redemption_url: self.config.redemption_url(),
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
        })
        .map_err(|_| ReferenceApplicationError::InvalidRedemptionBinding)?;
        let dpop_expires_at = dpop
            .issued_at()
            .checked_add(DPOP_FRESHNESS_WINDOW_SECONDS)
            .ok_or(ReferenceApplicationError::TimeOverflow)?;
        Ok(self
            .repository
            .redeem(ValidatedRedemption {
                issuer: gate_pass.issuer(),
                pass_id: gate_pass.pass_id(),
                audience: gate_pass.audience(),
                action_reference: gate_pass.action_reference(),
                claimant_jkt: gate_pass.claimant_jkt(),
                protected_action_type: gate_pass.protected_action_type(),
                action_policy: gate_pass.action_policy(),
                dpop_proof_id: dpop.proof_id(),
                accepted_at_unix_seconds: now,
                dpop_expires_at_unix_seconds: dpop_expires_at,
                outcome_lookup_window_seconds: self.config.outcome_lookup_window_seconds(),
            })
            .await?)
    }

    /// Claims and processes at most one durable Protected Action execution intent.
    pub async fn process_next_action(
        &self,
        worker_id: &ActionWorkerId,
        now: u64,
    ) -> Result<ActionProcessingOutcome, ReferenceApplicationError> {
        let lease_expires_at = now
            .checked_add(ACTION_LEASE_SECONDS)
            .ok_or(ReferenceApplicationError::TimeOverflow)?;
        let maybe_action = self
            .repository
            .maybe_claim_action(worker_id.as_str(), now, lease_expires_at)
            .await?;
        let Some(action) = maybe_action else {
            return Ok(ActionProcessingOutcome::NoWork);
        };
        let maybe_executor = self.config.maybe_account_creation_executor().cloned();
        match maybe_executor {
            None => return Err(ReferenceApplicationError::ExecutionUnavailable),
            Some(AccountCreationExecutor::Fail(error_class)) => {
                let completed_at = current_unix_seconds()?;
                if execution_failure_decision(&action.retryable_error_classes, &error_class)
                    == ExecutionFailureDecision::Retry
                {
                    let retry_at = completed_at
                        .checked_add(1)
                        .ok_or(ReferenceApplicationError::TimeOverflow)?;
                    self.repository
                        .schedule_action_retry(worker_id.as_str(), &action, retry_at)
                        .await?;
                    return Ok(ActionProcessingOutcome::RetryScheduled {
                        redemption_id: action.redemption_id,
                    });
                }
                self.repository
                    .fail_claimed_action(
                        worker_id.as_str(),
                        &action,
                        "action_execution_failed",
                        completed_at,
                    )
                    .await?;
                return Ok(ActionProcessingOutcome::Failed {
                    redemption_id: action.redemption_id,
                });
            }
            Some(AccountCreationExecutor::Succeed) => {}
        }
        let completed_at = current_unix_seconds()?;
        let record = self
            .repository
            .complete_account_creation(worker_id.as_str(), &action, completed_at)
            .await?;
        Ok(ActionProcessingOutcome::Succeeded {
            redemption_id: record.redemption_id,
        })
    }

    pub(crate) async fn outcome(
        &self,
        action_reference: &str,
        compact_proof: &str,
        now: u64,
    ) -> Result<RedemptionRecord, ReferenceApplicationError> {
        let proof = verify_outcome_proof(compact_proof)
            .map_err(|_| ReferenceApplicationError::InvalidOutcomeProof)?;
        if proof.action_reference() != action_reference
            || proof.http_method() != "GET"
            || proof.http_uri() != self.config.outcome_lookup_url(action_reference)
        {
            return Err(ReferenceApplicationError::WrongOutcomeProofRequest);
        }
        if now.abs_diff(proof.issued_at()) > OUTCOME_PROOF_FRESHNESS_SECONDS {
            return Err(ReferenceApplicationError::StaleOutcomeProof);
        }
        let binding = match self
            .repository
            .outcome_binding(self.config.relying_service_audience(), action_reference)
            .await
        {
            Ok(binding) => binding,
            Err(ReferencePersistenceError::UnknownProtectedAction) => {
                return Err(ReferenceApplicationError::OutcomeUnavailable);
            }
            Err(error) => return Err(error.into()),
        };
        if binding.claimant_jkt != proof.claimant_jkt()
            || now >= binding.public_lookup_expires_at_unix_seconds
        {
            return Err(ReferenceApplicationError::OutcomeUnavailable);
        }
        let proof_expires_at = proof
            .issued_at()
            .checked_add(OUTCOME_PROOF_FRESHNESS_SECONDS)
            .ok_or(ReferenceApplicationError::TimeOverflow)?;
        self.repository
            .consume_outcome_proof(proof.proof_id(), proof_expires_at, now)
            .await?;
        Ok(self
            .repository
            .redemption_record(&binding.redemption_id)
            .await?)
    }
}

/// Stable identity used to own one recoverable Protected Action execution lease.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionWorkerId(String);

impl ActionWorkerId {
    fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for ActionWorkerId {
    type Error = ReferenceApplicationError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        let maybe_suffix = value.strip_prefix("action_worker_");
        let Some(suffix) = maybe_suffix else {
            return Err(ReferenceApplicationError::InvalidWorkerId);
        };
        if suffix.is_empty()
            || value.len() > MAXIMUM_WORKER_ID_LENGTH
            || !suffix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(ReferenceApplicationError::InvalidWorkerId);
        }
        Ok(Self(value))
    }
}

/// Observable result of one bounded action-worker iteration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionProcessingOutcome {
    NoWork,
    Succeeded { redemption_id: String },
    Failed { redemption_id: String },
    RetryScheduled { redemption_id: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExecutionFailureDecision {
    Retry,
    Fail,
}

fn execution_failure_decision(
    retryable_error_classes: &[String],
    error_class: &str,
) -> ExecutionFailureDecision {
    if retryable_error_classes
        .iter()
        .any(|retryable| retryable == error_class)
    {
        return ExecutionFailureDecision::Retry;
    }
    ExecutionFailureDecision::Fail
}

fn current_unix_seconds() -> Result<u64, ReferenceApplicationError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| ReferenceApplicationError::ClockUnavailable)
}

#[derive(Debug, Error)]
pub enum ReferenceApplicationError {
    #[error("Claimant key is not a valid P-256 public JWK")]
    InvalidClaimantKey,
    #[error("durable trusted Authority key set is invalid")]
    InvalidTrustedAuthorityKeys,
    #[error("Redemption binding is invalid")]
    InvalidRedemptionBinding,
    #[error("Gate Pass conflicts with the persisted Protected Action")]
    ActionBindingConflict,
    #[error("Gate Pass was already consumed")]
    ConsumedPass,
    #[error("DPoP proof identity was already consumed")]
    ReplayedDpopProof,
    #[error("Redemption time overflow")]
    TimeOverflow,
    #[error("action worker identity is invalid")]
    InvalidWorkerId,
    #[error("reference Protected Action executor is unavailable")]
    ExecutionUnavailable,
    #[error("system clock is unavailable")]
    ClockUnavailable,
    #[error("Claimant Outcome Proof is invalid")]
    InvalidOutcomeProof,
    #[error("Claimant Outcome Proof request binding is invalid")]
    WrongOutcomeProofRequest,
    #[error("Claimant Outcome Proof is outside the freshness window")]
    StaleOutcomeProof,
    #[error("Protected Action outcome is unavailable")]
    OutcomeUnavailable,
    #[error("Claimant Outcome Proof identity was already consumed")]
    ReplayedOutcomeProof,
    #[error("Relying Service persistence failed")]
    Persistence(#[source] Box<dyn std::error::Error + Send + Sync>),
    #[error(transparent)]
    Crypto(#[from] CryptoProfileError),
}

impl From<ReferencePersistenceError> for ReferenceApplicationError {
    fn from(error: ReferencePersistenceError) -> Self {
        match error {
            ReferencePersistenceError::ConsumedPass => Self::ConsumedPass,
            ReferencePersistenceError::ReplayedDpopProof => Self::ReplayedDpopProof,
            ReferencePersistenceError::ActionBindingConflict
            | ReferencePersistenceError::UnknownProtectedAction => Self::ActionBindingConflict,
            ReferencePersistenceError::ReplayedOutcomeProof => Self::ReplayedOutcomeProof,
            error => Self::Persistence(Box::new(error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_transient_execution_failure_is_retryable() {
        // Arrange
        let retryable = vec!["transient".to_owned()];

        // Act
        let decision = execution_failure_decision(&retryable, "transient");

        // Assert
        assert_eq!(decision, ExecutionFailureDecision::Retry);
    }

    #[test]
    fn unlisted_execution_failure_is_terminal() {
        // Arrange
        let retryable = vec!["transient".to_owned()];

        // Act
        let decision = execution_failure_decision(&retryable, "permanent");

        // Assert
        assert_eq!(decision, ExecutionFailureDecision::Fail);
    }
}
