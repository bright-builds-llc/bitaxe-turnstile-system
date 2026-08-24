use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::challenge::ChallengeId;

/// Default lifetime of an issued Work Challenge.
pub const WORK_CHALLENGE_TTL_SECONDS: u64 = 15 * 60;
/// Maximum duration of one Work Lease before an authenticated renewal is required.
pub const WORK_LEASE_MAX_DURATION_SECONDS: u64 = 60;
/// Renewal cadence while Worker control continuity remains healthy.
pub const WORK_LEASE_RENEWAL_SECONDS: u64 = 20;
/// Freshness window for one single-use DPoP proof.
pub const DPOP_FRESHNESS_SECONDS: u64 = 60;
/// Redemption lifetime of an issued Gate Pass.
pub const GATE_PASS_TTL_SECONDS: u64 = 2 * 60;
/// BWG/0.1 verifiers do not extend signed deadlines for clock skew.
pub const PROTOCOL_CLOCK_SKEW_SECONDS: u64 = 0;
/// Complete DPoP acceptance window including the bounded verifier-skew allowance.
pub const DPOP_ACCEPTANCE_WINDOW_SECONDS: u64 =
    DPOP_FRESHNESS_SECONDS.saturating_add(PROTOCOL_CLOCK_SKEW_SECONDS);

/// Whether a non-future proof issue time remains inside its freshness window.
pub fn request_proof_is_fresh(now: u64, issued_at: u64, freshness_seconds: u64) -> bool {
    issued_at <= now.saturating_add(PROTOCOL_CLOCK_SKEW_SECONDS)
        && now
            <= issued_at
                .saturating_add(freshness_seconds)
                .saturating_add(PROTOCOL_CLOCK_SKEW_SECONDS)
}

/// Whether one signed artifact is valid in its inclusive-issued, exclusive-expiry interval.
pub fn signed_artifact_is_time_valid(now: u64, issued_at: u64, expires_at: u64) -> bool {
    now >= issued_at && now < expires_at.saturating_add(PROTOCOL_CLOCK_SKEW_SECONDS)
}

/// Durable Work Challenge lifecycle state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChallengeLifecycleState {
    Issued,
    Active,
    Satisfied,
    PassIssued,
    Cancelled,
    Expired,
}

impl ChallengeLifecycleState {
    pub(crate) fn parse(value: &str) -> Result<Self, LifecycleError> {
        match value {
            "issued" => Ok(Self::Issued),
            "active" => Ok(Self::Active),
            "satisfied" => Ok(Self::Satisfied),
            "pass_issued" => Ok(Self::PassIssued),
            "cancelled" => Ok(Self::Cancelled),
            "expired" => Ok(Self::Expired),
            _ => Err(LifecycleError::InvalidPersistedState),
        }
    }

    /// Whether retained progress can still lead to authorization.
    pub fn authorization_eligible(self) -> bool {
        !matches!(self, Self::Cancelled | Self::Expired)
    }
}

/// Returns whether the requested Work Challenge transition is allowed.
pub fn challenge_transition_allowed(
    from: ChallengeLifecycleState,
    to: ChallengeLifecycleState,
) -> bool {
    from == to
        || matches!(
            (from, to),
            (
                ChallengeLifecycleState::Issued,
                ChallengeLifecycleState::Active
                    | ChallengeLifecycleState::Cancelled
                    | ChallengeLifecycleState::Expired
            ) | (
                ChallengeLifecycleState::Active,
                ChallengeLifecycleState::Satisfied
                    | ChallengeLifecycleState::Cancelled
                    | ChallengeLifecycleState::Expired
            ) | (
                ChallengeLifecycleState::Satisfied,
                ChallengeLifecycleState::PassIssued | ChallengeLifecycleState::Expired
            ) | (
                ChallengeLifecycleState::PassIssued,
                ChallengeLifecycleState::Expired
            )
        )
}

/// Applies one state transition after validating the complete challenge matrix.
pub fn challenge_transition(
    from: ChallengeLifecycleState,
    to: ChallengeLifecycleState,
) -> Result<ChallengeLifecycleState, LifecycleError> {
    if !challenge_transition_allowed(from, to) {
        return Err(LifecycleError::ForbiddenTransition);
    }
    Ok(to)
}

/// Whether lifecycle control may still register or pause challenge work.
pub fn challenge_accepts_work_control(state: ChallengeLifecycleState) -> bool {
    matches!(
        state,
        ChallengeLifecycleState::Issued | ChallengeLifecycleState::Active
    )
}

/// Whether accepted work may advance the challenge projection.
pub fn challenge_accepts_work(state: ChallengeLifecycleState) -> bool {
    state == ChallengeLifecycleState::Active
}

/// Intent applied to one Work Challenge by an application or persistence adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChallengeLifecycleCommand {
    RegisterSession,
    SelectPoolOffer,
    ConfirmPoolSelection,
    StartWork,
    AcceptWork,
    Pause,
    Satisfy,
    IssuePass,
    Cancel,
    Expire,
}

/// Pure Work Challenge command decision used by every production adapter.
pub fn apply_challenge_command(
    state: ChallengeLifecycleState,
    command: ChallengeLifecycleCommand,
) -> Result<ChallengeLifecycleState, LifecycleError> {
    let maybe_target = match (state, command) {
        (
            ChallengeLifecycleState::Issued | ChallengeLifecycleState::Active,
            ChallengeLifecycleCommand::RegisterSession | ChallengeLifecycleCommand::Pause,
        ) => Some(state),
        (
            ChallengeLifecycleState::Issued,
            ChallengeLifecycleCommand::SelectPoolOffer
            | ChallengeLifecycleCommand::ConfirmPoolSelection,
        ) => Some(state),
        (ChallengeLifecycleState::Issued, ChallengeLifecycleCommand::StartWork) => {
            Some(ChallengeLifecycleState::Active)
        }
        (ChallengeLifecycleState::Active, ChallengeLifecycleCommand::StartWork) => Some(state),
        (ChallengeLifecycleState::Active, ChallengeLifecycleCommand::AcceptWork) => Some(state),
        (ChallengeLifecycleState::Active, ChallengeLifecycleCommand::Satisfy) => {
            Some(ChallengeLifecycleState::Satisfied)
        }
        (ChallengeLifecycleState::Satisfied, ChallengeLifecycleCommand::IssuePass) => {
            Some(ChallengeLifecycleState::PassIssued)
        }
        (ChallengeLifecycleState::PassIssued, ChallengeLifecycleCommand::IssuePass) => Some(state),
        (
            ChallengeLifecycleState::Issued | ChallengeLifecycleState::Active,
            ChallengeLifecycleCommand::Cancel,
        ) => Some(ChallengeLifecycleState::Cancelled),
        (ChallengeLifecycleState::Cancelled, ChallengeLifecycleCommand::Cancel) => Some(state),
        (_, ChallengeLifecycleCommand::Expire)
            if challenge_transition_allowed(state, ChallengeLifecycleState::Expired) =>
        {
            Some(ChallengeLifecycleState::Expired)
        }
        _ => None,
    };
    maybe_target.ok_or(LifecycleError::ForbiddenTransition)
}

mod session;

pub(crate) use session::{LeaseObservation, LeaseObservationInput, observe_work_lease};
pub use session::{
    PauseReason, SessionLifecycle, SessionLifecycleCommand, SessionLifecycleState,
    SessionStopReason, WorkLease, WorkerClock, WorkerInterruption, apply_session_command,
    session_transition, session_transition_allowed,
};
/// Redacted claimant-facing view of a Work Challenge lifecycle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChallengeLifecycle {
    challenge_id: ChallengeId,
    state: ChallengeLifecycleState,
    verified_progress: String,
    work_requirement: String,
    authorization_eligible: bool,
    expires_at_unix_seconds: u64,
    lifecycle_deadline_unix_seconds: u64,
}

impl ChallengeLifecycle {
    pub(crate) fn persisted(
        challenge_id: ChallengeId,
        state: ChallengeLifecycleState,
        verified_progress: String,
        work_requirement: String,
        expires_at_unix_seconds: u64,
        lifecycle_deadline_unix_seconds: u64,
    ) -> Self {
        Self {
            challenge_id,
            state,
            verified_progress,
            work_requirement,
            authorization_eligible: state.authorization_eligible(),
            expires_at_unix_seconds,
            lifecycle_deadline_unix_seconds,
        }
    }

    /// Current durable state.
    pub fn state(&self) -> ChallengeLifecycleState {
        self.state
    }

    /// Opaque Work Challenge identity.
    pub fn challenge_id(&self) -> &ChallengeId {
        &self.challenge_id
    }

    /// Exact integer progress accepted by the Authority.
    pub fn verified_progress(&self) -> &str {
        &self.verified_progress
    }

    /// Exact integer work required by the immutable challenge.
    pub fn work_requirement(&self) -> &str {
        &self.work_requirement
    }

    /// Whether retained progress can still lead to authorization.
    pub fn authorization_eligible(&self) -> bool {
        self.authorization_eligible
    }

    /// Absolute Work Challenge expiry.
    pub fn expires_at_unix_seconds(&self) -> u64 {
        self.expires_at_unix_seconds
    }

    /// Deadline that will next expire the challenge or its issued Gate Pass.
    pub fn lifecycle_deadline_unix_seconds(&self) -> u64 {
        self.lifecycle_deadline_unix_seconds
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum LifecycleError {
    #[error("Worker continuity identity is invalid")]
    InvalidContinuityId,
    #[error("persisted lifecycle state is invalid")]
    InvalidPersistedState,
    #[error("requested lifecycle transition is forbidden")]
    ForbiddenTransition,
    #[error("Work Lease identity does not match the active lease")]
    WrongWorkLease,
    #[error("lifecycle deadline overflow")]
    DeadlineOverflow,
}
