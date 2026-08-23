use std::collections::{HashMap, HashSet};

use serde::Serialize;
use thiserror::Error;

use crate::{
    challenge::ChallengeId,
    work::{AssignedTarget, CreditedWork, VerifiedProgress, WorkError},
};

const MAXIMUM_OPAQUE_ID_LENGTH: usize = 128;
mod service;
#[cfg(test)]
mod tests;

pub use service::ProgressService;

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

impl AcceptedWorkEventId {
    pub(crate) fn as_str(&self) -> &str {
        &self.0
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

impl WorkSessionId {
    pub(crate) fn as_str(&self) -> &str {
        &self.0
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

impl ShareFingerprint {
    pub(crate) fn as_str(&self) -> &str {
        &self.0
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

impl ReceiptTime {
    pub(crate) fn unix_seconds(self) -> u64 {
        self.0
    }
}

/// Whether an accepted result also met the Bitcoin network target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkTargetOutcome {
    BelowNetworkTarget,
    NetworkTargetMet,
}

impl NetworkTargetOutcome {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::BelowNetworkTarget => "below_network_target",
            Self::NetworkTargetMet => "network_target_met",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self, ProgressError> {
        match value {
            "below_network_target" => Ok(Self::BelowNetworkTarget),
            "network_target_met" => Ok(Self::NetworkTargetMet),
            _ => Err(ProgressError::InvalidPersistedData),
        }
    }
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

impl AcceptedWorkEvent {
    /// Returns the challenge-scoped Work Session named by this event.
    pub fn work_session_id(&self) -> &WorkSessionId {
        &self.work_session_id
    }

    /// Returns the server receipt time carried by this accepted event.
    pub fn received_at_unix_seconds(&self) -> u64 {
        self.received_at.unix_seconds()
    }

    pub(crate) fn event_id(&self) -> &AcceptedWorkEventId {
        &self.event_id
    }

    pub(crate) fn assigned_target(&self) -> AssignedTarget {
        self.assigned_target
    }

    pub(crate) fn received_at(&self) -> ReceiptTime {
        self.received_at
    }

    pub(crate) fn share_fingerprint(&self) -> &ShareFingerprint {
        &self.share_fingerprint
    }

    pub(crate) fn network_target_outcome(&self) -> NetworkTargetOutcome {
        self.network_target_outcome
    }

    fn matches_authoritative_replay(&self, other: &Self) -> bool {
        self.event_id == other.event_id
            && self.work_session_id == other.work_session_id
            && self.assigned_target == other.assigned_target
            && self.received_at == other.received_at
            && self.share_fingerprint == other.share_fingerprint
            && self.network_target_outcome == other.network_target_outcome
    }
}

/// Observable treatment of one Accepted Work Event delivery.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AcceptedWorkDisposition {
    Credited,
    DuplicateShare,
    ChallengeSatisfied,
}

impl AcceptedWorkDisposition {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Credited => "credited",
            Self::DuplicateShare => "duplicate_share",
            Self::ChallengeSatisfied => "challenge_satisfied",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self, ProgressError> {
        match value {
            "credited" => Ok(Self::Credited),
            "duplicate_share" => Ok(Self::DuplicateShare),
            "challenge_satisfied" => Ok(Self::ChallengeSatisfied),
            _ => Err(ProgressError::InvalidPersistedData),
        }
    }
}

pub(crate) struct AcceptedWorkTransitionInput {
    pub progress_before: VerifiedProgress,
    pub work_requirement: CreditedWork,
    pub credited_work: CreditedWork,
    pub fingerprint_inserted: bool,
}

pub(crate) struct AcceptedWorkTransition {
    pub disposition: AcceptedWorkDisposition,
    pub maybe_credited_work: Option<CreditedWork>,
    pub verified_progress: VerifiedProgress,
    pub satisfied: bool,
    pub issuance_intent_created: bool,
}

pub(crate) fn accepted_work_transition(
    input: AcceptedWorkTransitionInput,
) -> Result<AcceptedWorkTransition, ProgressError> {
    let already_satisfied = input.progress_before.meets(input.work_requirement);
    let maybe_credited_work = if already_satisfied || !input.fingerprint_inserted {
        None
    } else {
        Some(input.credited_work)
    };
    let verified_progress = match maybe_credited_work {
        Some(credited_work) => input.progress_before.checked_add(credited_work)?,
        None => input.progress_before,
    };
    let satisfied = already_satisfied || verified_progress.meets(input.work_requirement);
    let issuance_intent_created = !already_satisfied && satisfied;
    let disposition = if already_satisfied {
        AcceptedWorkDisposition::ChallengeSatisfied
    } else if !input.fingerprint_inserted {
        AcceptedWorkDisposition::DuplicateShare
    } else {
        AcceptedWorkDisposition::Credited
    };
    Ok(AcceptedWorkTransition {
        disposition,
        maybe_credited_work,
        verified_progress,
        satisfied,
        issuance_intent_created,
    })
}

pub(crate) fn ensure_event_before_challenge_expiry(
    event_received_at: u64,
    challenge_expires_at: u64,
) -> Result<(), ProgressError> {
    if event_received_at >= challenge_expires_at {
        return Err(ProgressError::ChallengeExpired);
    }
    Ok(())
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
    issuance_intent_created: bool,
}

impl AcceptedWorkAcknowledgement {
    pub(crate) fn persisted(input: PersistedAcknowledgementInput) -> Self {
        Self {
            event_id: input.event_id,
            work_session_id: input.work_session_id,
            received_at: input.received_at,
            network_target_outcome: input.network_target_outcome,
            disposition: input.disposition,
            maybe_credited_work: input.maybe_credited_work,
            verified_progress: input.verified_progress,
            work_requirement: input.work_requirement,
            issuance_intent_created: input.issuance_intent_created,
        }
    }

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

    /// Returns whether this acknowledgement crossed the threshold and created issuance intent.
    pub fn issuance_intent_created(&self) -> bool {
        self.issuance_intent_created
    }

    pub(crate) fn work_requirement(&self) -> CreditedWork {
        self.work_requirement
    }
}

pub(crate) struct PersistedAcknowledgementInput {
    pub event_id: AcceptedWorkEventId,
    pub work_session_id: WorkSessionId,
    pub received_at: ReceiptTime,
    pub network_target_outcome: NetworkTargetOutcome,
    pub disposition: AcceptedWorkDisposition,
    pub maybe_credited_work: Option<CreditedWork>,
    pub verified_progress: VerifiedProgress,
    pub work_requirement: CreditedWork,
    pub issuance_intent_created: bool,
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
    challenge_id: ChallengeId,
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
    pub(crate) fn persisted(
        challenge_id: ChallengeId,
        verified_progress: VerifiedProgress,
        work_requirement: CreditedWork,
    ) -> Self {
        Self {
            challenge_id,
            verified_progress,
            work_requirement,
            satisfied: verified_progress.meets(work_requirement),
            activity_estimate: ActivityEstimate {
                status: ActivityEstimateStatus::Unavailable,
            },
        }
    }

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
    event_records: HashMap<AcceptedWorkEventId, AcceptedEventRecord>,
    share_fingerprints: HashSet<ShareFingerprint>,
}

struct AcceptedEventRecord {
    event: AcceptedWorkEvent,
    acknowledgement: AcceptedWorkAcknowledgement,
}

impl AcceptedEventRecord {
    fn new(event: AcceptedWorkEvent, acknowledgement: AcceptedWorkAcknowledgement) -> Self {
        Self {
            event,
            acknowledgement,
        }
    }

    fn replay_acknowledgement(
        &self,
        event: &AcceptedWorkEvent,
    ) -> Result<AcceptedWorkAcknowledgement, ProgressError> {
        if !self.event.matches_authoritative_replay(event) {
            return Err(ProgressError::ConflictingEventReplay);
        }
        Ok(self.acknowledgement.clone())
    }
}

impl ChallengeProgress {
    /// Creates a zero-progress projection with an immutable Work Requirement.
    pub fn new(work_requirement: CreditedWork) -> Self {
        Self {
            work_requirement,
            verified_progress: VerifiedProgress::zero(),
            work_sessions: HashSet::new(),
            event_records: HashMap::new(),
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
        self.accept_with_global_duplicate(event, false)
    }

    fn accept_with_global_duplicate(
        &mut self,
        event: AcceptedWorkEvent,
        globally_duplicate_share: bool,
    ) -> Result<AcceptedWorkAcknowledgement, ProgressError> {
        if let Some(record) = self.event_records.get(&event.event_id) {
            return record.replay_acknowledgement(&event);
        }
        if !self.work_sessions.contains(&event.work_session_id) {
            return Err(ProgressError::UnknownWorkSession);
        }

        let duplicate_share =
            globally_duplicate_share || self.share_fingerprints.contains(&event.share_fingerprint);
        let transition = accepted_work_transition(AcceptedWorkTransitionInput {
            progress_before: self.verified_progress,
            work_requirement: self.work_requirement,
            credited_work: event.assigned_target.credited_work(),
            fingerprint_inserted: !duplicate_share,
        })?;
        self.verified_progress = transition.verified_progress;
        self.share_fingerprints
            .insert(event.share_fingerprint.clone());

        // Worker-reported work and lucky depth are deliberately non-authoritative.
        let recorded_event = event.clone();
        drop(event.maybe_worker_report);
        let acknowledgement = AcceptedWorkAcknowledgement {
            event_id: event.event_id.clone(),
            work_session_id: event.work_session_id,
            received_at: event.received_at,
            network_target_outcome: event.network_target_outcome,
            disposition: transition.disposition,
            maybe_credited_work: transition.maybe_credited_work,
            verified_progress: self.verified_progress,
            work_requirement: self.work_requirement,
            issuance_intent_created: transition.issuance_intent_created,
        };
        self.event_records.insert(
            event.event_id,
            AcceptedEventRecord::new(recorded_event, acknowledgement.clone()),
        );
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

    fn update(&self, challenge_id: ChallengeId) -> ProgressUpdate {
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
    #[error("Accepted Work Event identity conflicts with its canonical delivery")]
    ConflictingEventReplay,
    #[error("Work Challenge is already registered")]
    DuplicateChallenge,
    #[error("Work Challenge is not registered")]
    UnknownChallenge,
    #[error("Accepted Work Event was received at or after Work Challenge expiry")]
    ChallengeExpired,
    #[error("persisted progress data is invalid")]
    InvalidPersistedData,
    #[error("progress projection state is unavailable")]
    ProgressStateUnavailable,
    #[error("system clock is unavailable")]
    ClockUnavailable,
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
