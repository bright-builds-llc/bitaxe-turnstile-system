use async_trait::async_trait;
use thiserror::Error;

use crate::{
    challenge::{ChallengeId, WorkChallengeDescriptor},
    crypto_profile::{GatePassClaimsSeed, GatePassClaimsTemplate},
    lifecycle::{
        ChallengeLifecycle, PauseReason, SessionLifecycle, SessionReplacement, WorkLease,
        WorkerClock, WorkerInterruption,
    },
    pool_offer::PoolSelectionCommitment,
    pool_offer::{
        MaterialPoolOfferConfirmation, PoolOffer, PoolOfferChange, PoolOfferReplacementDecision,
    },
    progress::{AcceptedWorkAcknowledgement, AcceptedWorkEvent, ProgressError, WorkSessionId},
    trusted_consent::{
        TrustedConsentBinding, TrustedConsentCeremony, TrustedConsentCeremonyId,
        TrustedConsentLeaseAdmission, TrustedConsentOperationOwner,
    },
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

pub(crate) struct PersistedSessionPoolSelection {
    pub challenge_id: ChallengeId,
    pub selection: PoolSelectionCommitment,
    pub maybe_replacement_offer: Option<PoolOffer>,
}

pub(crate) struct PersistPoolOfferReplacement<'a> {
    pub replaced_session_id: &'a WorkSessionId,
    pub candidate_session_id: &'a WorkSessionId,
    pub challenge_id: &'a ChallengeId,
    pub prior_offer: &'a PoolOffer,
    pub candidate_offer: &'a PoolOffer,
    pub candidate_signature: &'a str,
    pub candidate_set_digest: &'a str,
    pub change: &'a PoolOfferChange,
    pub now: u64,
}

pub(crate) struct PendingMaterialPoolOfferReplacement {
    pub challenge_id: ChallengeId,
    pub replaced_session_id: WorkSessionId,
    pub candidate_session_id: WorkSessionId,
    pub prior_offer: PoolOffer,
    pub candidate_offer: PoolOffer,
    pub change: PoolOfferChange,
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

pub(crate) struct StartWorkLeaseInput<'a> {
    pub session_id: &'a WorkSessionId,
    pub maybe_trusted_consent: Option<&'a TrustedConsentLeaseAdmission<'a>>,
    pub clock: &'a WorkerClock,
    pub lease_id: &'a str,
    pub renew_at_monotonic_milliseconds: u64,
    pub expires_at_monotonic_milliseconds: u64,
    pub now_unix_seconds: u64,
}

pub(crate) enum TrustedConsentCeremonyRecord {
    Starting {
        ceremony: TrustedConsentCeremony,
    },
    Pending {
        ceremony: TrustedConsentCeremony,
        creation_options: serde_json::Value,
        registration_state: serde_json::Value,
    },
    Verifying {
        ceremony: TrustedConsentCeremony,
        creation_options: serde_json::Value,
        registration_state: serde_json::Value,
    },
    Verified {
        ceremony: TrustedConsentCeremony,
    },
    Failed {
        ceremony: TrustedConsentCeremony,
    },
}

impl TrustedConsentCeremonyRecord {
    pub(crate) fn ceremony(&self) -> &TrustedConsentCeremony {
        match self {
            Self::Starting { ceremony }
            | Self::Pending { ceremony, .. }
            | Self::Verifying { ceremony, .. }
            | Self::Verified { ceremony }
            | Self::Failed { ceremony } => ceremony,
        }
    }
}

pub(crate) struct ReserveTrustedConsentCeremony<'a> {
    pub ceremony: &'a TrustedConsentCeremony,
    pub operation_owner: TrustedConsentOperationOwner,
    pub lease_expires_at_unix_seconds: u64,
}

pub(crate) enum TrustedConsentReservation {
    Claimed,
    Existing(Box<TrustedConsentCeremonyRecord>),
    InProgress,
}

pub(crate) enum TrustedConsentVerificationClaim {
    Claimed(TrustedConsentCeremonyRecord),
    InProgress,
    Verified(TrustedConsentCeremonyRecord),
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
        now: u64,
    ) -> Result<(), AuthorityPersistenceError>;

    async fn replace_work_session(
        &self,
        replaced_session_id: &WorkSessionId,
        session_id: &WorkSessionId,
        now: u64,
    ) -> Result<SessionReplacement, AuthorityPersistenceError>;

    async fn maybe_session_replacement(
        &self,
        session_id: &WorkSessionId,
    ) -> Result<Option<SessionReplacement>, AuthorityPersistenceError>;

    async fn session_pool_selection(
        &self,
        session_id: &WorkSessionId,
    ) -> Result<PersistedSessionPoolSelection, AuthorityPersistenceError>;

    async fn persist_pool_offer_replacement(
        &self,
        input: PersistPoolOfferReplacement<'_>,
    ) -> Result<PoolOfferReplacementDecision, AuthorityPersistenceError>;

    async fn pool_failover_projection(
        &self,
        replaced_session_id: &WorkSessionId,
    ) -> Result<crate::pool_offer::PoolFailoverProjection, AuthorityPersistenceError>;

    async fn pending_material_pool_offer_replacement(
        &self,
        replaced_session_id: &WorkSessionId,
    ) -> Result<PendingMaterialPoolOfferReplacement, AuthorityPersistenceError>;

    async fn persist_material_pool_offer_confirmation(
        &self,
        confirmation: &MaterialPoolOfferConfirmation,
    ) -> Result<MaterialPoolOfferConfirmation, AuthorityPersistenceError>;

    async fn maybe_material_pool_offer_confirmation(
        &self,
        replaced_session_id: &WorkSessionId,
    ) -> Result<Option<MaterialPoolOfferConfirmation>, AuthorityPersistenceError>;

    async fn maybe_material_confirmation_by_binding(
        &self,
        challenge_id: &ChallengeId,
        signature_digest_sha256: &crate::pool_offer::Sha256Base64Url,
    ) -> Result<Option<MaterialPoolOfferConfirmation>, AuthorityPersistenceError>;

    async fn release_material_pool_offer_replacement(
        &self,
        replaced_session_id: &WorkSessionId,
        candidate_session_id: &WorkSessionId,
        now: u64,
    ) -> Result<crate::lifecycle::SessionReplacement, AuthorityPersistenceError>;

    async fn propose_pool_selection(
        &self,
        challenge_id: &ChallengeId,
        pool_offer_id: &str,
        payout_commitment: &str,
        now: u64,
    ) -> Result<PoolSelectionCommitment, AuthorityPersistenceError>;

    async fn confirm_pool_selection(
        &self,
        challenge_id: &ChallengeId,
        payout_commitment: &str,
        now: u64,
    ) -> Result<PoolSelectionCommitment, AuthorityPersistenceError>;

    async fn challenge_lifecycle(
        &self,
        challenge_id: &ChallengeId,
        now: u64,
    ) -> Result<ChallengeLifecycle, AuthorityPersistenceError>;

    async fn pause_challenge(
        &self,
        challenge_id: &ChallengeId,
        reason: PauseReason,
        now: u64,
    ) -> Result<ChallengeLifecycle, AuthorityPersistenceError>;

    async fn cancel_challenge(
        &self,
        challenge_id: &ChallengeId,
        now: u64,
    ) -> Result<ChallengeLifecycle, AuthorityPersistenceError>;

    async fn start_work_lease(
        &self,
        input: StartWorkLeaseInput<'_>,
    ) -> Result<WorkLease, AuthorityPersistenceError>;

    async fn renew_work_lease(
        &self,
        session_id: &WorkSessionId,
        lease_id: &str,
        clock: &WorkerClock,
        renew_at_monotonic_milliseconds: u64,
        expires_at_monotonic_milliseconds: u64,
        now: u64,
    ) -> Result<WorkLease, AuthorityPersistenceError>;

    async fn interrupt_work_session(
        &self,
        session_id: &WorkSessionId,
        interruption: WorkerInterruption,
    ) -> Result<(), AuthorityPersistenceError>;

    async fn confirm_work_session_restored(
        &self,
        session_id: &WorkSessionId,
    ) -> Result<(), AuthorityPersistenceError>;

    async fn fail_work_session(
        &self,
        session_id: &WorkSessionId,
    ) -> Result<(), AuthorityPersistenceError>;

    async fn work_session_lifecycle(
        &self,
        session_id: &WorkSessionId,
    ) -> Result<SessionLifecycle, AuthorityPersistenceError>;

    async fn accept_work(
        &self,
        event: AcceptedWorkEvent,
        lease_id: &str,
        clock: &WorkerClock,
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

    async fn maybe_trusted_consent_by_binding(
        &self,
        binding: &TrustedConsentBinding,
    ) -> Result<Option<TrustedConsentCeremonyRecord>, AuthorityPersistenceError>;

    async fn reserve_trusted_consent_ceremony(
        &self,
        input: ReserveTrustedConsentCeremony<'_>,
    ) -> Result<TrustedConsentReservation, AuthorityPersistenceError>;

    async fn initialize_trusted_consent_ceremony(
        &self,
        ceremony_id: &TrustedConsentCeremonyId,
        operation_owner: TrustedConsentOperationOwner,
        creation_options: &serde_json::Value,
        registration_state: &serde_json::Value,
        initialized_at_unix_seconds: u64,
    ) -> Result<TrustedConsentCeremonyRecord, AuthorityPersistenceError>;

    async fn abandon_trusted_consent_reservation(
        &self,
        ceremony_id: &TrustedConsentCeremonyId,
        operation_owner: TrustedConsentOperationOwner,
    ) -> Result<(), AuthorityPersistenceError>;

    async fn trusted_consent_ceremony(
        &self,
        ceremony_id: &TrustedConsentCeremonyId,
    ) -> Result<TrustedConsentCeremonyRecord, AuthorityPersistenceError>;

    async fn claim_trusted_consent_verification(
        &self,
        ceremony_id: &TrustedConsentCeremonyId,
        operation_owner: TrustedConsentOperationOwner,
        now_unix_seconds: u64,
        lease_expires_at_unix_seconds: u64,
    ) -> Result<TrustedConsentVerificationClaim, AuthorityPersistenceError>;

    async fn complete_trusted_consent_ceremony(
        &self,
        ceremony_id: &TrustedConsentCeremonyId,
        operation_owner: TrustedConsentOperationOwner,
        verified_at_unix_seconds: u64,
    ) -> Result<TrustedConsentCeremonyRecord, AuthorityPersistenceError>;

    async fn fail_trusted_consent_ceremony(
        &self,
        ceremony_id: &TrustedConsentCeremonyId,
        operation_owner: TrustedConsentOperationOwner,
        failed_at_unix_seconds: u64,
    ) -> Result<TrustedConsentCeremonyRecord, AuthorityPersistenceError>;

    async fn persist_trusted_consent_receipt(
        &self,
        ceremony_id: &TrustedConsentCeremonyId,
        compact_receipt: &str,
        issued_at_unix_seconds: u64,
        expires_at_unix_seconds: u64,
    ) -> Result<String, AuthorityPersistenceError>;

    async fn maybe_trusted_consent_receipt(
        &self,
        ceremony_id: &TrustedConsentCeremonyId,
    ) -> Result<Option<String>, AuthorityPersistenceError>;

    async fn retire_expired_trusted_consent_ceremonies(
        &self,
        now_unix_seconds: u64,
    ) -> Result<u64, AuthorityPersistenceError>;
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
    #[error("Work Session predecessor already has a different replacement")]
    ConflictingWorkSessionReplacement,
    #[error("requested lifecycle transition is forbidden")]
    ForbiddenLifecycleTransition,
    #[error("Work Lease identity does not match the active lease")]
    WrongWorkLease,
    #[error("Worker continuity was lost")]
    WorkerContinuityLost,
    #[error("Work Lease has reached its monotonic deadline")]
    WorkLeaseExpired,
    #[error("a consented Pool Selection is required before work begins")]
    PoolSelectionRequired,
    #[error("Pool Selection is immutable after Work Consent")]
    PoolSelectionLocked,
    #[error("Pool Selection commitment does not match the proposed terms")]
    PoolSelectionMismatch,
    #[error("Pool Offer replacement conflicts with its durable decision")]
    ConflictingPoolOfferReplacement,
    #[error("Pool Offer replacement was not found")]
    UnknownPoolOfferReplacement,
    #[error("Accepted Work Event identity conflicts with its canonical delivery")]
    ConflictingEventReplay,
    #[error("Gate Pass signing lease is no longer owned by this worker")]
    LostSigningLease,
    #[error("Claimant Issuance Proof identity was already consumed")]
    ReplayedIssuanceProof,
    #[error("Trusted Consent ceremony was not found")]
    UnknownTrustedConsentCeremony,
    #[error("Trusted Consent verification lease was lost")]
    LostTrustedConsentVerificationLease,
    #[error("Trusted Consent receipt is required before work begins")]
    TrustedConsentRequired,
    #[error("Trusted Consent receipt does not authorize this lease")]
    InvalidTrustedConsentReceipt,
    #[error("Trusted Consent receipt was already admitted to another Work Session")]
    TrustedConsentReceiptReplayed,
    #[error("Work Challenge is no longer awaiting Trusted Consent")]
    TrustedConsentChallengeUnavailable,
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
    #[error(transparent)]
    InvalidLifecycle(#[from] crate::lifecycle::LifecycleError),
}
