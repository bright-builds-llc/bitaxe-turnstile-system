use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};

use serde::Serialize;
use thiserror::Error;
use tokio::sync::broadcast;

use crate::work::{AssignedTarget, CreditedWork, VerifiedProgress, WorkError};

const MAXIMUM_OPAQUE_ID_LENGTH: usize = 128;
const PROGRESS_CHANNEL_CAPACITY: usize = 32;

#[cfg(test)]
mod tests;

/// Opaque Work Challenge identity used by the progress service.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct ProgressChallengeId(String);

impl TryFrom<String> for ProgressChallengeId {
    type Error = ProgressError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        validate_opaque_id(&value, "challenge_")?;
        Ok(Self(value))
    }
}

/// Stable Pool Adapter identity for one at-least-once Accepted Work Event.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct AcceptedWorkEventId(String);

impl TryFrom<String> for AcceptedWorkEventId {
    type Error = ProgressError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        validate_opaque_id(&value, "event_")?;
        Ok(Self(value))
    }
}

/// Challenge-scoped identity for one contributing Work Session.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct WorkSessionId(String);

impl TryFrom<String> for WorkSessionId {
    type Error = ProgressError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        validate_opaque_id(&value, "session_")?;
        Ok(Self(value))
    }
}

/// Stable fingerprint preventing one accepted share from funding several events.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct ShareFingerprint(String);

impl TryFrom<String> for ShareFingerprint {
    type Error = ProgressError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        validate_opaque_id(&value, "share_")?;
        Ok(Self(value))
    }
}

/// Server receipt time retained with an Accepted Work Event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct ReceiptTime(u64);

impl TryFrom<u64> for ReceiptTime {
    type Error = ProgressError;

    fn try_from(value: u64) -> Result<Self, Self::Error> {
        if value == 0 {
            return Err(ProgressError::InvalidReceiptTime);
        }
        Ok(Self(value))
    }
}

/// Whether an accepted result also met the Bitcoin network target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkTargetOutcome {
    BelowNetworkTarget,
    NetworkTargetMet,
}

/// Non-authoritative Worker telemetry retained only for diagnostics or display.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WorkerReport {
    pub reported_hashes: String,
    pub reported_hashrate_hs: f64,
    pub lucky_hash_leading_zero_bits: u16,
}

/// A target-qualified result durably accepted by a Pool Adapter.
#[derive(Debug, Clone, PartialEq)]
pub struct AcceptedWorkEvent {
    event_id: AcceptedWorkEventId,
    work_session_id: WorkSessionId,
    assigned_target: AssignedTarget,
    received_at: ReceiptTime,
    share_fingerprint: ShareFingerprint,
    network_target_outcome: NetworkTargetOutcome,
    maybe_worker_report: Option<WorkerReport>,
}

/// Parsed adapter input used to construct one Accepted Work Event.
pub struct AcceptedWorkEventInput {
    pub event_id: AcceptedWorkEventId,
    pub work_session_id: WorkSessionId,
    pub assigned_target: [u8; 32],
    pub received_at: ReceiptTime,
    pub share_fingerprint: ShareFingerprint,
    pub network_target_outcome: NetworkTargetOutcome,
    pub maybe_worker_report: Option<WorkerReport>,
}

impl TryFrom<AcceptedWorkEventInput> for AcceptedWorkEvent {
    type Error = ProgressError;

    fn try_from(input: AcceptedWorkEventInput) -> Result<Self, Self::Error> {
        Ok(Self {
            event_id: input.event_id,
            work_session_id: input.work_session_id,
            assigned_target: AssignedTarget::from_be_bytes(input.assigned_target)?,
            received_at: input.received_at,
            share_fingerprint: input.share_fingerprint,
            network_target_outcome: input.network_target_outcome,
            maybe_worker_report: input.maybe_worker_report,
        })
    }
}

/// Observable treatment of one Accepted Work Event delivery.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AcceptedWorkDisposition {
    Credited,
    DuplicateShare,
}

/// Stable acknowledgement returned for original and replayed event delivery.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AcceptedWorkAcknowledgement {
    event_id: AcceptedWorkEventId,
    work_session_id: WorkSessionId,
    received_at: ReceiptTime,
    network_target_outcome: NetworkTargetOutcome,
    disposition: AcceptedWorkDisposition,
    maybe_credited_work: Option<CreditedWork>,
    verified_progress: VerifiedProgress,
    work_requirement: CreditedWork,
}

impl AcceptedWorkAcknowledgement {
    /// Returns work added by this event, or absence for a duplicate share.
    pub fn maybe_credited_work(&self) -> Option<CreditedWork> {
        self.maybe_credited_work
    }

    /// Returns exact cumulative Verified Progress after this event.
    pub fn verified_progress(&self) -> VerifiedProgress {
        self.verified_progress
    }

    /// Returns how the event affected the projection.
    pub fn disposition(&self) -> AcceptedWorkDisposition {
        self.disposition
    }
}

/// Non-authoritative activity status kept separate from Verified Progress.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityEstimateStatus {
    Unavailable,
}

/// Public lifecycle payload sent through Server-Sent Events.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProgressUpdate {
    challenge_id: ProgressChallengeId,
    verified_progress: VerifiedProgress,
    work_requirement: CreditedWork,
    satisfied: bool,
    activity_estimate: ActivityEstimate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct ActivityEstimate {
    status: ActivityEstimateStatus,
}

impl ProgressUpdate {
    /// Returns exact cumulative Verified Progress.
    pub fn verified_progress(&self) -> VerifiedProgress {
        self.verified_progress
    }
}

/// Pure in-memory projection for one Work Challenge.
pub struct ChallengeProgress {
    work_requirement: CreditedWork,
    verified_progress: VerifiedProgress,
    work_sessions: HashSet<WorkSessionId>,
    acknowledgements: HashMap<AcceptedWorkEventId, AcceptedWorkAcknowledgement>,
    share_fingerprints: HashSet<ShareFingerprint>,
}

impl ChallengeProgress {
    /// Creates a zero-progress projection with an immutable Work Requirement.
    pub fn new(work_requirement: CreditedWork) -> Self {
        Self {
            work_requirement,
            verified_progress: VerifiedProgress::zero(),
            work_sessions: HashSet::new(),
            acknowledgements: HashMap::new(),
            share_fingerprints: HashSet::new(),
        }
    }

    /// Registers an authenticated one-to-one Work Session mapping.
    pub fn register_session(&mut self, session_id: WorkSessionId) -> Result<(), ProgressError> {
        if !self.work_sessions.insert(session_id) {
            return Err(ProgressError::DuplicateWorkSession);
        }
        Ok(())
    }

    /// Applies or idempotently replays one accepted event.
    pub fn accept(
        &mut self,
        event: AcceptedWorkEvent,
    ) -> Result<AcceptedWorkAcknowledgement, ProgressError> {
        if let Some(acknowledgement) = self.acknowledgements.get(&event.event_id) {
            return Ok(acknowledgement.clone());
        }
        if !self.work_sessions.contains(&event.work_session_id) {
            return Err(ProgressError::UnknownWorkSession);
        }

        let duplicate_share = self.share_fingerprints.contains(&event.share_fingerprint);
        let maybe_credited_work = if duplicate_share {
            None
        } else {
            let credited_work = event.assigned_target.credited_work();
            self.verified_progress = self.verified_progress.checked_add(credited_work)?;
            self.share_fingerprints
                .insert(event.share_fingerprint.clone());
            Some(credited_work)
        };
        let disposition = if duplicate_share {
            AcceptedWorkDisposition::DuplicateShare
        } else {
            AcceptedWorkDisposition::Credited
        };

        // Worker-reported work and lucky depth are deliberately non-authoritative.
        let _maybe_worker_report = event.maybe_worker_report;
        let acknowledgement = AcceptedWorkAcknowledgement {
            event_id: event.event_id.clone(),
            work_session_id: event.work_session_id,
            received_at: event.received_at,
            network_target_outcome: event.network_target_outcome,
            disposition,
            maybe_credited_work,
            verified_progress: self.verified_progress,
            work_requirement: self.work_requirement,
        };
        self.acknowledgements
            .insert(event.event_id, acknowledgement.clone());
        Ok(acknowledgement)
    }

    /// Returns exact current Verified Progress.
    pub fn verified_progress(&self) -> VerifiedProgress {
        self.verified_progress
    }

    /// Returns whether exact progress reached the immutable requirement.
    pub fn is_satisfied(&self) -> bool {
        self.verified_progress.meets(self.work_requirement)
    }

    fn update(&self, challenge_id: ProgressChallengeId) -> ProgressUpdate {
        ProgressUpdate {
            challenge_id,
            verified_progress: self.verified_progress,
            work_requirement: self.work_requirement,
            satisfied: self.is_satisfied(),
            activity_estimate: ActivityEstimate {
                status: ActivityEstimateStatus::Unavailable,
            },
        }
    }
}

/// Shared application service used by the simulated adapter and SSE shell.
#[derive(Clone, Default)]
pub struct ProgressService {
    state: Arc<Mutex<ProgressServiceState>>,
}

#[derive(Default)]
struct ProgressServiceState {
    challenges: HashMap<ProgressChallengeId, ChallengeChannel>,
    work_sessions: HashMap<WorkSessionId, ProgressChallengeId>,
}

struct ChallengeChannel {
    progress: ChallengeProgress,
    updates: broadcast::Sender<ProgressUpdate>,
}

impl ProgressService {
    /// Registers an immutable issued challenge before accepting Work Sessions.
    pub fn register_challenge(
        &self,
        challenge_id: ProgressChallengeId,
        work_requirement: CreditedWork,
    ) -> Result<(), ProgressError> {
        let mut state = self.lock_state()?;
        if state.challenges.contains_key(&challenge_id) {
            return Err(ProgressError::DuplicateChallenge);
        }
        let (updates, _receiver) = broadcast::channel(PROGRESS_CHANNEL_CAPACITY);
        state.challenges.insert(
            challenge_id,
            ChallengeChannel {
                progress: ChallengeProgress::new(work_requirement),
                updates,
            },
        );
        Ok(())
    }

    /// Binds one opaque Work Session to exactly one registered challenge.
    pub fn register_session(
        &self,
        challenge_id: &ProgressChallengeId,
        session_id: WorkSessionId,
    ) -> Result<(), ProgressError> {
        let mut state = self.lock_state()?;
        if state.work_sessions.contains_key(&session_id) {
            return Err(ProgressError::DuplicateWorkSession);
        }
        let maybe_channel = state.challenges.get_mut(challenge_id);
        let Some(channel) = maybe_channel else {
            return Err(ProgressError::UnknownChallenge);
        };
        channel.progress.register_session(session_id.clone())?;
        state.work_sessions.insert(session_id, challenge_id.clone());
        Ok(())
    }

    /// Applies one event and returns its stable replay acknowledgement.
    pub fn report(
        &self,
        event: AcceptedWorkEvent,
    ) -> Result<AcceptedWorkAcknowledgement, ProgressError> {
        let mut state = self.lock_state()?;
        let maybe_challenge_id = state.work_sessions.get(&event.work_session_id).cloned();
        let Some(challenge_id) = maybe_challenge_id else {
            return Err(ProgressError::UnknownWorkSession);
        };
        let channel = state
            .challenges
            .get_mut(&challenge_id)
            .ok_or(ProgressError::UnknownChallenge)?;
        let progress_before = channel.progress.verified_progress();
        let acknowledgement = channel.progress.accept(event)?;
        if channel.progress.verified_progress() != progress_before
            && channel.updates.receiver_count() > 0
        {
            channel
                .updates
                .send(channel.progress.update(challenge_id))
                .map_err(|_| ProgressError::ProgressStreamUnavailable)?;
        }
        Ok(acknowledgement)
    }

    /// Returns a current snapshot and receiver for subsequent updates.
    pub fn subscribe(
        &self,
        challenge_id: &ProgressChallengeId,
    ) -> Result<(ProgressUpdate, broadcast::Receiver<ProgressUpdate>), ProgressError> {
        let state = self.lock_state()?;
        let channel = state
            .challenges
            .get(challenge_id)
            .ok_or(ProgressError::UnknownChallenge)?;
        Ok((
            channel.progress.update(challenge_id.clone()),
            channel.updates.subscribe(),
        ))
    }

    fn lock_state(&self) -> Result<std::sync::MutexGuard<'_, ProgressServiceState>, ProgressError> {
        self.state
            .lock()
            .map_err(|_| ProgressError::ProgressStateUnavailable)
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ProgressError {
    #[error("opaque progress identifier is invalid")]
    InvalidIdentifier,
    #[error("receipt time must be after the Unix epoch")]
    InvalidReceiptTime,
    #[error("Work Session is already registered")]
    DuplicateWorkSession,
    #[error("Accepted Work Event names an unknown Work Session")]
    UnknownWorkSession,
    #[error("Work Challenge is already registered")]
    DuplicateChallenge,
    #[error("Work Challenge is not registered")]
    UnknownChallenge,
    #[error("progress projection state is unavailable")]
    ProgressStateUnavailable,
    #[error("progress stream is unavailable")]
    ProgressStreamUnavailable,
    #[error(transparent)]
    InvalidWork(#[from] WorkError),
}

fn validate_opaque_id(value: &str, prefix: &str) -> Result<(), ProgressError> {
    let maybe_suffix = value.strip_prefix(prefix);
    let Some(suffix) = maybe_suffix else {
        return Err(ProgressError::InvalidIdentifier);
    };
    if suffix.is_empty()
        || value.len() > MAXIMUM_OPAQUE_ID_LENGTH
        || !suffix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(ProgressError::InvalidIdentifier);
    }
    Ok(())
}
