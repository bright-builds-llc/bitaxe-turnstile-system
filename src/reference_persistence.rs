use async_trait::async_trait;
use thiserror::Error;

mod postgres;

pub(crate) use postgres::PostgresReferenceRepository;

pub(crate) struct NewProtectedAction<'a> {
    pub audience: &'a str,
    pub action_reference: &'a str,
    pub claimant_jkt: &'a str,
    pub protected_action_type: &'a str,
    pub action_policy: &'a str,
    pub execution_timeout_seconds: u64,
    pub maximum_attempts: u32,
    pub retryable_error_classes: &'a [&'a str],
    pub created_at_unix_seconds: u64,
}

pub(crate) struct ValidatedRedemption<'a> {
    pub issuer: &'a str,
    pub pass_id: &'a str,
    pub audience: &'a str,
    pub action_reference: &'a str,
    pub claimant_jkt: &'a str,
    pub protected_action_type: &'a str,
    pub action_policy: &'a str,
    pub dpop_proof_id: &'a str,
    pub accepted_at_unix_seconds: u64,
    pub dpop_expires_at_unix_seconds: u64,
    pub outcome_lookup_window_seconds: u64,
}

pub(crate) struct ClaimedAction {
    pub redemption_id: String,
    pub action_reference: String,
    pub attempt_number: u32,
    pub retryable_error_classes: Vec<String>,
}

pub(crate) struct OutcomeBinding {
    pub redemption_id: String,
    pub claimant_jkt: String,
    pub public_lookup_expires_at_unix_seconds: u64,
}

#[async_trait]
pub(crate) trait ReferenceRepository: Send + Sync {
    async fn replace_trusted_authority_keys(
        &self,
        issuer: &str,
        keys: &[crate::crypto_profile::AuthorityJwkWire],
    ) -> Result<(), ReferencePersistenceError>;

    async fn trusted_authority_keys(
        &self,
        issuer: &str,
    ) -> Result<Vec<crate::crypto_profile::AuthorityJwkWire>, ReferencePersistenceError>;

    async fn insert_protected_action(
        &self,
        action: NewProtectedAction<'_>,
    ) -> Result<(), ReferencePersistenceError>;

    async fn redeem(
        &self,
        redemption: ValidatedRedemption<'_>,
    ) -> Result<crate::redemption::RedemptionRecord, ReferencePersistenceError>;

    async fn maybe_claim_action(
        &self,
        worker_id: &str,
        now: u64,
        lease_expires_at: u64,
    ) -> Result<Option<ClaimedAction>, ReferencePersistenceError>;

    async fn complete_account_creation(
        &self,
        worker_id: &str,
        action: &ClaimedAction,
        completed_at: u64,
    ) -> Result<crate::redemption::RedemptionRecord, ReferencePersistenceError>;

    async fn fail_claimed_action(
        &self,
        worker_id: &str,
        action: &ClaimedAction,
        safe_reason: &str,
        completed_at: u64,
    ) -> Result<(), ReferencePersistenceError>;

    async fn schedule_action_retry(
        &self,
        worker_id: &str,
        action: &ClaimedAction,
        retry_at: u64,
    ) -> Result<(), ReferencePersistenceError>;

    async fn outcome_binding(
        &self,
        audience: &str,
        action_reference: &str,
    ) -> Result<OutcomeBinding, ReferencePersistenceError>;

    async fn consume_outcome_proof(
        &self,
        proof_id: &str,
        expires_at: u64,
        now: u64,
    ) -> Result<(), ReferencePersistenceError>;

    async fn redemption_record(
        &self,
        redemption_id: &str,
    ) -> Result<crate::redemption::RedemptionRecord, ReferencePersistenceError>;
}

#[derive(Debug, Error)]
pub(crate) enum ReferencePersistenceError {
    #[error("Protected Action is already persisted")]
    DuplicateProtectedAction,
    #[error("Protected Action is unavailable")]
    UnknownProtectedAction,
    #[error("persisted Relying Service data is invalid")]
    InvalidPersistedData,
    #[error("Gate Pass was already consumed")]
    ConsumedPass,
    #[error("DPoP proof identity was already consumed")]
    ReplayedDpopProof,
    #[error("Gate Pass conflicts with the persisted Protected Action")]
    ActionBindingConflict,
    #[error("Action execution lease is no longer owned by this worker")]
    LostExecutionLease,
    #[error("Claimant Outcome Proof identity was already consumed")]
    ReplayedOutcomeProof,
    #[error("Relying Service database operation failed")]
    Database(#[from] sqlx::Error),
    #[error("Relying Service migration failed")]
    Migration(#[from] sqlx::migrate::MigrateError),
}
