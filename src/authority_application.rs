use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use thiserror::Error;
use tokio::sync::broadcast;

use crate::{
    authority::Config,
    authority_persistence::{
        AuthorityPersistenceError, AuthorityRepository, PersistedIssuance,
        PostgresAuthorityRepository,
    },
    challenge::{ChallengeId, WorkChallengeDescriptor},
    crypto_profile::{
        CryptoProfileError, GATE_PASS_JWS_ALGORITHM, GatePassClaimsSeed, GatePassConfirmationInput,
        P256PublicJwk, P256PublicJwkWire, p256_jwk_thumbprint, verify_issuance_proof,
    },
    progress::{
        AcceptedWorkAcknowledgement, AcceptedWorkEvent, ProgressError, ProgressUpdate,
        WorkSessionId,
    },
};

const PROGRESS_CHANNEL_CAPACITY: usize = 32;
const SIGNING_LEASE_SECONDS: u64 = 30;
const GATE_PASS_TTL_SECONDS: u64 = 2 * 60;
const MAXIMUM_WORKER_ID_LENGTH: usize = 128;
const ISSUANCE_PROOF_FRESHNESS_SECONDS: u64 = 60;

/// PostgreSQL-backed Gate Authority application module shared by public adapters.
#[derive(Clone)]
pub struct AuthorityApplication {
    pub(crate) config: Config,
    repository: Arc<dyn AuthorityRepository>,
    progress_channels: Arc<Mutex<HashMap<ChallengeId, broadcast::Sender<ProgressUpdate>>>>,
}

impl AuthorityApplication {
    /// Connects the Gate Authority to its authoritative PostgreSQL schema and applies migrations.
    pub async fn connect_postgres(
        config: Config,
        database_url: &str,
    ) -> Result<Self, AuthorityApplicationError> {
        let repository = PostgresAuthorityRepository::connect(database_url).await?;
        Ok(Self {
            config,
            repository: Arc::new(repository),
            progress_channels: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub(crate) async fn insert_challenge(
        &self,
        descriptor: &WorkChallengeDescriptor,
    ) -> Result<(), AuthorityApplicationError> {
        let claimant_key = claimant_key(descriptor)?;
        let claims_seed = GatePassClaimsSeed {
            iss: self.config.issuer().to_owned(),
            aud: descriptor.relying_service_audience().to_owned(),
            challenge_id: descriptor.challenge_id().to_owned(),
            protected_action_type: descriptor
                .action_policy()
                .protected_action_type()
                .id()
                .to_owned(),
            action_reference: descriptor.action_reference().to_owned(),
            action_policy: descriptor.action_policy().id().to_owned(),
            cnf: GatePassConfirmationInput {
                jkt: p256_jwk_thumbprint(&claimant_key),
            },
            bwg_version: "BWG/0.1".to_owned(),
        };
        self.repository
            .insert_challenge(descriptor, &claims_seed)
            .await?;
        Ok(())
    }

    /// Returns the Pool Adapter interface backed by the same Authority transaction module.
    pub fn simulated_pool_adapter(&self) -> SimulatedPoolAdapter {
        SimulatedPoolAdapter {
            application: self.clone(),
        }
    }

    async fn insert_work_session(
        &self,
        challenge_id: &ChallengeId,
        session_id: &WorkSessionId,
    ) -> Result<(), AuthorityApplicationError> {
        self.repository
            .insert_work_session(challenge_id, session_id)
            .await?;
        Ok(())
    }

    async fn accept_work(
        &self,
        event: AcceptedWorkEvent,
    ) -> Result<AcceptedWorkAcknowledgement, AuthorityApplicationError> {
        let acceptance = self.repository.accept_work(event).await?;
        let update = ProgressUpdate::persisted(
            acceptance.challenge_id.clone(),
            acceptance.acknowledgement.verified_progress(),
            acceptance.acknowledgement.work_requirement(),
        );
        self.notify_progress(&acceptance.challenge_id, update)?;
        Ok(acceptance.acknowledgement)
    }

    /// Claims and processes at most one durable Gate Pass issuance intent.
    pub async fn process_next_issuance(
        &self,
        worker_id: &IssuanceWorkerId,
        now: u64,
    ) -> Result<IssuanceProcessingOutcome, AuthorityApplicationError> {
        let lease_expires_at = now
            .checked_add(SIGNING_LEASE_SECONDS)
            .ok_or(AuthorityApplicationError::TimeOverflow)?;
        let maybe_claimed = self
            .repository
            .maybe_claim_issuance(worker_id.as_str(), now, lease_expires_at)
            .await?;
        let Some(claimed) = maybe_claimed else {
            return Ok(IssuanceProcessingOutcome::NoWork);
        };
        let signer = self
            .config
            .maybe_signer()
            .ok_or(AuthorityApplicationError::SigningUnavailable)?;
        if claimed.algorithm != GATE_PASS_JWS_ALGORITHM {
            return Err(AuthorityApplicationError::UnsupportedSigningAlgorithm);
        }
        let issued_at = current_unix_seconds()?;
        let expires_at = issued_at
            .checked_add(GATE_PASS_TTL_SECONDS)
            .ok_or(AuthorityApplicationError::TimeOverflow)?;
        let claims = claimed.claims_template.with_times(issued_at, expires_at);
        let gate_pass = signer.sign_gate_pass(&claims)?;
        self.repository
            .complete_issuance(
                worker_id.as_str(),
                &claimed.challenge_id,
                signer.kid(),
                &gate_pass,
                issued_at,
                expires_at,
            )
            .await?;
        Ok(IssuanceProcessingOutcome::Issued {
            challenge_id: claimed.challenge_id,
        })
    }

    pub(crate) async fn issuance(
        &self,
        challenge_id: &ChallengeId,
        compact_proof: &str,
        now: u64,
    ) -> Result<IssuanceLookup, AuthorityApplicationError> {
        let proof = verify_issuance_proof(compact_proof)
            .map_err(|_| AuthorityApplicationError::InvalidClaimantProof)?;
        if proof.challenge_id() != challenge_id.as_str()
            || proof.http_method() != "GET"
            || proof.http_uri() != self.config.issuance_lookup_url(challenge_id)
        {
            return Err(AuthorityApplicationError::WrongIssuanceProofRequest);
        }
        if now.abs_diff(proof.issued_at()) > ISSUANCE_PROOF_FRESHNESS_SECONDS {
            return Err(AuthorityApplicationError::StaleIssuanceProof);
        }
        let descriptor = self.repository.challenge(challenge_id).await?;
        let claimant_key = claimant_key(&descriptor)?;
        if proof.claimant_jkt() != p256_jwk_thumbprint(&claimant_key) {
            return Err(AuthorityApplicationError::WrongClaimantKey);
        }
        let proof_expires_at = proof
            .issued_at()
            .checked_add(ISSUANCE_PROOF_FRESHNESS_SECONDS)
            .ok_or(AuthorityApplicationError::TimeOverflow)?;
        self.repository
            .consume_issuance_proof(challenge_id, proof.proof_id(), proof_expires_at, now)
            .await?;
        Ok(match self.repository.issuance(challenge_id).await? {
            PersistedIssuance::Pending => IssuanceLookup::Pending,
            PersistedIssuance::Issued { gate_pass } => IssuanceLookup::Issued { gate_pass },
            PersistedIssuance::Failed => IssuanceLookup::Failed,
        })
    }

    pub(crate) async fn subscribe_progress(
        &self,
        challenge_id: &ChallengeId,
    ) -> Result<(ProgressUpdate, broadcast::Receiver<ProgressUpdate>), AuthorityApplicationError>
    {
        let progress = self.repository.progress(challenge_id).await?;
        let snapshot = ProgressUpdate::persisted(
            progress.challenge_id,
            progress.verified_progress,
            progress.work_requirement,
        );
        let mut channels = self
            .progress_channels
            .lock()
            .map_err(|_| AuthorityApplicationError::StateUnavailable)?;
        let channel = channels.entry(challenge_id.clone()).or_insert_with(|| {
            let (updates, _receiver) = broadcast::channel(PROGRESS_CHANNEL_CAPACITY);
            updates
        });
        Ok((snapshot, channel.subscribe()))
    }

    fn notify_progress(
        &self,
        challenge_id: &ChallengeId,
        update: ProgressUpdate,
    ) -> Result<(), AuthorityApplicationError> {
        let maybe_updates = self
            .progress_channels
            .lock()
            .map_err(|_| AuthorityApplicationError::StateUnavailable)?
            .get(challenge_id)
            .cloned();
        let Some(updates) = maybe_updates else {
            return Ok(());
        };
        if updates.receiver_count() > 0
            && let Err(error) = updates.send(update)
        {
            tracing::debug!(%error, "progress subscriber disconnected before notification");
        }
        Ok(())
    }
}

fn claimant_key(
    descriptor: &WorkChallengeDescriptor,
) -> Result<P256PublicJwk, AuthorityApplicationError> {
    let claimant_wire = serde_json::from_str::<P256PublicJwkWire>(descriptor.claimant_key())
        .map_err(|_| AuthorityApplicationError::InvalidClaimantKey)?;
    P256PublicJwk::try_from(claimant_wire)
        .map_err(|_| AuthorityApplicationError::InvalidClaimantKey)
}

fn current_unix_seconds() -> Result<u64, AuthorityApplicationError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| AuthorityApplicationError::ClockUnavailable)
}

/// Stable identity used to own one recoverable Gate Pass signing lease.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssuanceWorkerId(String);

impl IssuanceWorkerId {
    fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for IssuanceWorkerId {
    type Error = AuthorityApplicationError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        let maybe_suffix = value.strip_prefix("worker_");
        let Some(suffix) = maybe_suffix else {
            return Err(AuthorityApplicationError::InvalidWorkerId);
        };
        if suffix.is_empty()
            || value.len() > MAXIMUM_WORKER_ID_LENGTH
            || !suffix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(AuthorityApplicationError::InvalidWorkerId);
        }
        Ok(Self(value))
    }
}

/// Observable result of one bounded issuance-worker iteration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IssuanceProcessingOutcome {
    NoWork,
    Issued { challenge_id: ChallengeId },
}

/// Claimant-visible durable Gate Pass issuance state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum IssuanceLookup {
    Pending,
    Issued { gate_pass: String },
    Failed,
}

/// Simulated Pool Adapter interface for the future authenticated gRPC transport.
#[derive(Clone)]
pub struct SimulatedPoolAdapter {
    application: AuthorityApplication,
}

impl SimulatedPoolAdapter {
    /// Binds one Work Session to its immutable Work Challenge.
    pub async fn register_session(
        &self,
        challenge_id: &ChallengeId,
        session_id: WorkSessionId,
    ) -> Result<(), AuthorityApplicationError> {
        self.application
            .insert_work_session(challenge_id, &session_id)
            .await
    }

    /// Atomically records one target-qualified accepted result and its stable acknowledgement.
    pub async fn report(
        &self,
        event: AcceptedWorkEvent,
    ) -> Result<AcceptedWorkAcknowledgement, AuthorityApplicationError> {
        self.application.accept_work(event).await
    }
}

#[derive(Debug, Error)]
pub enum AuthorityApplicationError {
    #[error("Gate Authority application state is unavailable")]
    StateUnavailable,
    #[error("Work Challenge is already persisted")]
    DuplicateChallenge,
    #[error("Work Challenge is not persisted")]
    UnknownChallenge,
    #[error("Work Session is already persisted")]
    DuplicateWorkSession,
    #[error("Work Session is not persisted")]
    UnknownWorkSession,
    #[error("Accepted Work Event conflicts with its canonical delivery")]
    ConflictingEventReplay,
    #[error("issuance worker identity is invalid")]
    InvalidWorkerId,
    #[error("Gate Pass signing key is unavailable")]
    SigningUnavailable,
    #[error("Gate Pass issuance time overflow")]
    TimeOverflow,
    #[error("Claimant key is not a valid P-256 public JWK")]
    InvalidClaimantKey,
    #[error("system clock is unavailable")]
    ClockUnavailable,
    #[error("issuance intent algorithm is unsupported")]
    UnsupportedSigningAlgorithm,
    #[error("Claimant Issuance Proof is invalid")]
    InvalidClaimantProof,
    #[error("Claimant Issuance Proof request binding is invalid")]
    WrongIssuanceProofRequest,
    #[error("Claimant Issuance Proof is outside the freshness window")]
    StaleIssuanceProof,
    #[error("Claimant Issuance Proof key does not match the Work Challenge")]
    WrongClaimantKey,
    #[error("Claimant Issuance Proof identity was already consumed")]
    ReplayedIssuanceProof,
    #[error("Gate Authority persistence failed")]
    Persistence(#[source] Box<dyn std::error::Error + Send + Sync>),
    #[error(transparent)]
    Progress(#[from] ProgressError),
    #[error(transparent)]
    Crypto(#[from] CryptoProfileError),
}

impl From<AuthorityPersistenceError> for AuthorityApplicationError {
    fn from(error: AuthorityPersistenceError) -> Self {
        match error {
            AuthorityPersistenceError::DuplicateChallenge => Self::DuplicateChallenge,
            AuthorityPersistenceError::UnknownChallenge => Self::UnknownChallenge,
            AuthorityPersistenceError::DuplicateWorkSession => Self::DuplicateWorkSession,
            AuthorityPersistenceError::UnknownWorkSession => Self::UnknownWorkSession,
            AuthorityPersistenceError::ConflictingEventReplay => Self::ConflictingEventReplay,
            AuthorityPersistenceError::ReplayedIssuanceProof => Self::ReplayedIssuanceProof,
            AuthorityPersistenceError::InvalidProgress(error) => Self::Progress(error),
            error => Self::Persistence(Box::new(error)),
        }
    }
}
