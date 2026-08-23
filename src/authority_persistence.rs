use async_trait::async_trait;
use thiserror::Error;

use crate::{
    challenge::{ChallengeId, WorkChallengeDescriptor},
    crypto_profile::{GatePassClaimsSeed, GatePassClaimsTemplate},
    progress::{AcceptedWorkAcknowledgement, AcceptedWorkEvent, ProgressError, WorkSessionId},
    work::{CreditedWork, VerifiedProgress, WorkError},
};

mod postgres;

pub(crate) use postgres::PostgresAuthorityRepository;

pub(crate) struct PersistedProgress {
    pub challenge_id: ChallengeId,
    pub verified_progress: VerifiedProgress,
    pub work_requirement: CreditedWork,
}

pub(crate) struct PersistedAcceptance {
    pub challenge_id: ChallengeId,
    pub acknowledgement: AcceptedWorkAcknowledgement,
}

pub(crate) struct ClaimedIssuance {
    pub challenge_id: ChallengeId,
    pub algorithm: String,
    pub claims_template: GatePassClaimsTemplate,
}

pub(crate) enum PersistedIssuance {
    Pending,
    Issued { gate_pass: String },
    Retired,
    Failed,
}

#[async_trait]
pub(crate) trait AuthorityRepository: Send + Sync {
    async fn insert_challenge(
        &self,
        descriptor: &WorkChallengeDescriptor,
        claims_seed: &GatePassClaimsSeed,
    ) -> Result<(), AuthorityPersistenceError>;

    async fn progress(
        &self,
        challenge_id: &ChallengeId,
    ) -> Result<PersistedProgress, AuthorityPersistenceError>;

    async fn insert_work_session(
        &self,
        challenge_id: &ChallengeId,
        session_id: &WorkSessionId,
    ) -> Result<(), AuthorityPersistenceError>;

    async fn accept_work(
        &self,
        event: AcceptedWorkEvent,
    ) -> Result<PersistedAcceptance, AuthorityPersistenceError>;

    async fn maybe_claim_issuance(
        &self,
        worker_id: &str,
        now: u64,
        lease_expires_at: u64,
    ) -> Result<Option<ClaimedIssuance>, AuthorityPersistenceError>;

    #[allow(clippy::too_many_arguments)]
    async fn complete_issuance(
        &self,
        worker_id: &str,
        challenge_id: &ChallengeId,
        authority_kid: &str,
        gate_pass: &str,
        issued_at: u64,
        expires_at: u64,
    ) -> Result<(), AuthorityPersistenceError>;

    async fn issuance(
        &self,
        challenge_id: &ChallengeId,
    ) -> Result<PersistedIssuance, AuthorityPersistenceError>;

    async fn challenge(
        &self,
        challenge_id: &ChallengeId,
    ) -> Result<WorkChallengeDescriptor, AuthorityPersistenceError>;

    async fn consume_issuance_proof(
        &self,
        challenge_id: &ChallengeId,
        proof_id: &str,
        expires_at: u64,
        now: u64,
    ) -> Result<(), AuthorityPersistenceError>;
}

#[derive(Debug, Error)]
pub(crate) enum AuthorityPersistenceError {
    #[error("Work Challenge is already persisted")]
    DuplicateChallenge,
    #[error("Work Challenge is not persisted")]
    UnknownChallenge,
    #[error("Work Session is already persisted")]
    DuplicateWorkSession,
    #[error("Work Session is not persisted")]
    UnknownWorkSession,
    #[error("Accepted Work Event identity conflicts with its canonical delivery")]
    ConflictingEventReplay,
    #[error("Gate Pass signing lease is no longer owned by this worker")]
    LostSigningLease,
    #[error("Claimant Issuance Proof identity was already consumed")]
    ReplayedIssuanceProof,
    #[error("persisted Authority data is invalid")]
    InvalidPersistedData,
    #[error("Gate Authority database operation failed")]
    Database(#[from] sqlx::Error),
    #[error("Gate Authority migration failed")]
    Migration(#[from] sqlx::migrate::MigrateError),
    #[error(transparent)]
    InvalidChallenge(#[from] crate::challenge::ChallengeError),
    #[error(transparent)]
    InvalidWork(#[from] WorkError),
    #[error(transparent)]
    InvalidProgress(#[from] ProgressError),
}
