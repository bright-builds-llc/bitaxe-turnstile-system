use serde::{Deserialize, Serialize};

use super::LifecycleError;
use crate::{challenge::ChallengeId, progress::WorkSessionId};

#[cfg(test)]
mod tests;

const MAXIMUM_CONTINUITY_ID_LENGTH: usize = 128;

/// Durable Work Session lifecycle state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionLifecycleState {
    Ready,
    Leased,
    Stopping,
    Restored,
    Failed,
}

impl SessionLifecycleState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Leased => "leased",
            Self::Stopping => "stopping",
            Self::Restored => "restored",
            Self::Failed => "failed",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self, LifecycleError> {
        match value {
            "ready" => Ok(Self::Ready),
            "leased" => Ok(Self::Leased),
            "stopping" => Ok(Self::Stopping),
            "restored" => Ok(Self::Restored),
            "failed" => Ok(Self::Failed),
            _ => Err(LifecycleError::InvalidPersistedState),
        }
    }
}

/// Returns whether the requested Work Session transition is allowed.
pub fn session_transition_allowed(from: SessionLifecycleState, to: SessionLifecycleState) -> bool {
    from == to
        || matches!(
            (from, to),
            (
                SessionLifecycleState::Ready,
                SessionLifecycleState::Leased
                    | SessionLifecycleState::Stopping
                    | SessionLifecycleState::Failed
            ) | (
                SessionLifecycleState::Leased,
                SessionLifecycleState::Stopping | SessionLifecycleState::Failed
            ) | (
                SessionLifecycleState::Stopping,
                SessionLifecycleState::Restored | SessionLifecycleState::Failed
            ) | (
                SessionLifecycleState::Restored,
                SessionLifecycleState::Leased | SessionLifecycleState::Failed
            )
        )
}

/// Applies one state transition after validating the complete session matrix.
pub fn session_transition(
    from: SessionLifecycleState,
    to: SessionLifecycleState,
) -> Result<SessionLifecycleState, LifecycleError> {
    if !session_transition_allowed(from, to) {
        return Err(LifecycleError::ForbiddenTransition);
    }
    Ok(to)
}

/// Intent applied to one Work Session by the Pool Adapter or challenge lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionLifecycleCommand {
    StartLease,
    ObserveLease,
    Stop,
    ConfirmRestored,
    Fail,
}

/// Pure Work Session command decision used by every production adapter.
pub fn apply_session_command(
    state: SessionLifecycleState,
    command: SessionLifecycleCommand,
) -> Result<SessionLifecycleState, LifecycleError> {
    let maybe_target = match (state, command) {
        (
            SessionLifecycleState::Ready | SessionLifecycleState::Restored,
            SessionLifecycleCommand::StartLease,
        ) => Some(SessionLifecycleState::Leased),
        (SessionLifecycleState::Leased, SessionLifecycleCommand::ObserveLease) => Some(state),
        (
            SessionLifecycleState::Ready | SessionLifecycleState::Leased,
            SessionLifecycleCommand::Stop,
        ) => Some(SessionLifecycleState::Stopping),
        (SessionLifecycleState::Stopping, SessionLifecycleCommand::Stop) => Some(state),
        (SessionLifecycleState::Stopping, SessionLifecycleCommand::ConfirmRestored) => {
            Some(SessionLifecycleState::Restored)
        }
        (SessionLifecycleState::Restored, SessionLifecycleCommand::ConfirmRestored) => Some(state),
        (_, SessionLifecycleCommand::Fail) => Some(SessionLifecycleState::Failed),
        _ => None,
    };
    maybe_target.ok_or(LifecycleError::ForbiddenTransition)
}

/// Why all leases for a challenge are being ended without cancelling it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PauseReason {
    UserRequested,
    TabClosed,
    ConnectivityLost,
}

impl PauseReason {
    /// Stable wire and persistence value.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UserRequested => "user_requested",
            Self::TabClosed => "tab_closed",
            Self::ConnectivityLost => "connectivity_lost",
        }
    }

    pub(crate) fn stop_reason(self) -> SessionStopReason {
        match self {
            Self::UserRequested => SessionStopReason::UserRequested,
            Self::TabClosed => SessionStopReason::TabClosed,
            Self::ConnectivityLost => SessionStopReason::ConnectivityLost,
        }
    }
}

/// Closed reason set for a session that is stopping, restored, or failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionStopReason {
    UserRequested,
    TabClosed,
    ConnectivityLost,
    ChallengeCancelled,
    ChallengeExpired,
    ChallengeSatisfied,
    WorkerReboot,
    MonotonicReset,
    UncertainTime,
    LeaseExpired,
    TransportDisconnected,
    SessionFailed,
    MigrationContinuityUnknown,
    MigrationPoolSelectionUnknown,
}

impl SessionStopReason {
    /// Stable persistence and Pool Adapter value.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UserRequested => "user_requested",
            Self::TabClosed => "tab_closed",
            Self::ConnectivityLost => "connectivity_lost",
            Self::ChallengeCancelled => "challenge_cancelled",
            Self::ChallengeExpired => "challenge_expired",
            Self::ChallengeSatisfied => "challenge_satisfied",
            Self::WorkerReboot => "worker_reboot",
            Self::MonotonicReset => "monotonic_reset",
            Self::UncertainTime => "uncertain_time",
            Self::LeaseExpired => "lease_expired",
            Self::TransportDisconnected => "transport_disconnected",
            Self::SessionFailed => "session_failed",
            Self::MigrationContinuityUnknown => "migration_continuity_unknown",
            Self::MigrationPoolSelectionUnknown => "migration_pool_selection_unknown",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self, LifecycleError> {
        match value {
            "user_requested" => Ok(Self::UserRequested),
            "tab_closed" => Ok(Self::TabClosed),
            "connectivity_lost" => Ok(Self::ConnectivityLost),
            "challenge_cancelled" => Ok(Self::ChallengeCancelled),
            "challenge_expired" => Ok(Self::ChallengeExpired),
            "challenge_satisfied" => Ok(Self::ChallengeSatisfied),
            "worker_reboot" => Ok(Self::WorkerReboot),
            "monotonic_reset" => Ok(Self::MonotonicReset),
            "uncertain_time" => Ok(Self::UncertainTime),
            "lease_expired" => Ok(Self::LeaseExpired),
            "transport_disconnected" => Ok(Self::TransportDisconnected),
            "session_failed" => Ok(Self::SessionFailed),
            "migration_continuity_unknown" => Ok(Self::MigrationContinuityUnknown),
            "migration_pool_selection_unknown" => Ok(Self::MigrationPoolSelectionUnknown),
            _ => Err(LifecycleError::InvalidPersistedState),
        }
    }

    pub(crate) fn allows_replacement(self) -> bool {
        matches!(
            self,
            Self::WorkerReboot
                | Self::MonotonicReset
                | Self::UncertainTime
                | Self::LeaseExpired
                | Self::TransportDisconnected
                | Self::SessionFailed
        )
    }
}

/// A Worker-side continuity failure that must end the current lease.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerInterruption {
    Reboot,
    MonotonicReset,
    UncertainTime,
    TransportDisconnected,
}

impl WorkerInterruption {
    /// Stable persistence value.
    pub fn as_str(self) -> &'static str {
        self.stop_reason().as_str()
    }

    pub(crate) fn stop_reason(self) -> SessionStopReason {
        match self {
            Self::Reboot => SessionStopReason::WorkerReboot,
            Self::MonotonicReset => SessionStopReason::MonotonicReset,
            Self::UncertainTime => SessionStopReason::UncertainTime,
            Self::TransportDisconnected => SessionStopReason::TransportDisconnected,
        }
    }
}

pub(crate) struct LeaseObservationInput<'a> {
    pub state: SessionLifecycleState,
    pub expected_lease_id: &'a str,
    pub expected_continuity_id: &'a str,
    pub last_monotonic_milliseconds: u64,
    pub expires_at_monotonic_milliseconds: u64,
    pub presented_lease_id: &'a str,
    pub clock: &'a WorkerClock,
}

pub(crate) enum LeaseObservation {
    Accepted,
    Stop(SessionStopReason),
}

pub(crate) fn observe_work_lease(
    input: LeaseObservationInput<'_>,
) -> Result<LeaseObservation, LifecycleError> {
    apply_session_command(input.state, SessionLifecycleCommand::ObserveLease)?;
    if input.expected_lease_id != input.presented_lease_id {
        return Err(LifecycleError::WrongWorkLease);
    }
    if input.expected_continuity_id != input.clock.continuity_id() {
        return Ok(LeaseObservation::Stop(SessionStopReason::WorkerReboot));
    }
    if input.clock.monotonic_milliseconds() < input.last_monotonic_milliseconds {
        return Ok(LeaseObservation::Stop(SessionStopReason::MonotonicReset));
    }
    if input.clock.monotonic_milliseconds() >= input.expires_at_monotonic_milliseconds {
        return Ok(LeaseObservation::Stop(SessionStopReason::LeaseExpired));
    }
    Ok(LeaseObservation::Accepted)
}

/// A reading from one continuous Worker boot and monotonic clock domain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerClock {
    continuity_id: String,
    monotonic_milliseconds: u64,
}

impl WorkerClock {
    /// Validates one opaque boot-continuity identifier and monotonic reading.
    pub fn new(
        continuity_id: impl Into<String>,
        monotonic_milliseconds: u64,
    ) -> Result<Self, LifecycleError> {
        let continuity_id = continuity_id.into();
        if continuity_id.is_empty()
            || continuity_id.len() > MAXIMUM_CONTINUITY_ID_LENGTH
            || !continuity_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(LifecycleError::InvalidContinuityId);
        }
        Ok(Self {
            continuity_id,
            monotonic_milliseconds,
        })
    }

    pub(crate) fn continuity_id(&self) -> &str {
        &self.continuity_id
    }

    pub(crate) fn monotonic_milliseconds(&self) -> u64 {
        self.monotonic_milliseconds
    }
}

/// One bounded lease expressed only in the Worker's monotonic clock domain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkLease {
    lease_id: String,
    renew_at_monotonic_milliseconds: u64,
    expires_at_monotonic_milliseconds: u64,
}

impl WorkLease {
    pub(crate) fn persisted(
        lease_id: String,
        renew_at_monotonic_milliseconds: u64,
        expires_at_monotonic_milliseconds: u64,
    ) -> Self {
        Self {
            lease_id,
            renew_at_monotonic_milliseconds,
            expires_at_monotonic_milliseconds,
        }
    }

    /// Stable identity of this lease grant.
    pub fn lease_id(&self) -> &str {
        &self.lease_id
    }

    /// Monotonic time at which a healthy controller should renew.
    pub fn renew_at_monotonic_milliseconds(&self) -> u64 {
        self.renew_at_monotonic_milliseconds
    }

    /// Monotonic hard stop after which the Worker restores its baseline.
    pub fn expires_at_monotonic_milliseconds(&self) -> u64 {
        self.expires_at_monotonic_milliseconds
    }
}

/// Pool-Adapter view whose shape makes invalid state/lease/reason combinations unrepresentable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionLifecycle {
    Ready {
        session_id: WorkSessionId,
        challenge_id: ChallengeId,
    },
    Leased {
        session_id: WorkSessionId,
        challenge_id: ChallengeId,
        lease: WorkLease,
    },
    Stopping {
        session_id: WorkSessionId,
        challenge_id: ChallengeId,
        reason: SessionStopReason,
    },
    Restored {
        session_id: WorkSessionId,
        challenge_id: ChallengeId,
        reason: SessionStopReason,
    },
    Failed {
        session_id: WorkSessionId,
        challenge_id: ChallengeId,
        reason: SessionStopReason,
    },
}

/// Durable operational transition from one stopped Work Session to a fresh replacement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionReplacement {
    session_id: WorkSessionId,
    replaced_session_id: WorkSessionId,
    generation: u64,
    reason: SessionStopReason,
}

impl SessionReplacement {
    pub(crate) fn persisted(
        session_id: WorkSessionId,
        replaced_session_id: WorkSessionId,
        generation: u64,
        reason: SessionStopReason,
    ) -> Result<Self, LifecycleError> {
        if generation == 0 || session_id == replaced_session_id || !reason.allows_replacement() {
            return Err(LifecycleError::InvalidPersistedState);
        }
        Ok(Self {
            session_id,
            replaced_session_id,
            generation,
            reason,
        })
    }

    /// Fresh Work Session created by this transition.
    pub fn session_id(&self) -> &WorkSessionId {
        &self.session_id
    }

    /// Stopped Work Session this transition replaces.
    pub fn replaced_session_id(&self) -> &WorkSessionId {
        &self.replaced_session_id
    }

    /// Monotonic replacement generation within the Work Challenge.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Authority-derived reason replacement became eligible.
    pub fn reason(&self) -> SessionStopReason {
        self.reason
    }
}

impl SessionLifecycle {
    pub(crate) fn persisted(
        session_id: WorkSessionId,
        challenge_id: ChallengeId,
        state: SessionLifecycleState,
        maybe_stop_reason: Option<String>,
        maybe_lease: Option<WorkLease>,
    ) -> Result<Self, LifecycleError> {
        let maybe_reason = maybe_stop_reason
            .as_deref()
            .map(SessionStopReason::parse)
            .transpose()?;
        match (state, maybe_reason, maybe_lease) {
            (SessionLifecycleState::Ready, None, None) => Ok(Self::Ready {
                session_id,
                challenge_id,
            }),
            (SessionLifecycleState::Leased, None, Some(lease)) => Ok(Self::Leased {
                session_id,
                challenge_id,
                lease,
            }),
            (SessionLifecycleState::Stopping, Some(reason), None) => Ok(Self::Stopping {
                session_id,
                challenge_id,
                reason,
            }),
            (SessionLifecycleState::Restored, Some(reason), None) => Ok(Self::Restored {
                session_id,
                challenge_id,
                reason,
            }),
            (SessionLifecycleState::Failed, Some(reason), None) => Ok(Self::Failed {
                session_id,
                challenge_id,
                reason,
            }),
            _ => Err(LifecycleError::InvalidPersistedState),
        }
    }

    /// Current durable state.
    pub fn state(&self) -> SessionLifecycleState {
        match self {
            Self::Ready { .. } => SessionLifecycleState::Ready,
            Self::Leased { .. } => SessionLifecycleState::Leased,
            Self::Stopping { .. } => SessionLifecycleState::Stopping,
            Self::Restored { .. } => SessionLifecycleState::Restored,
            Self::Failed { .. } => SessionLifecycleState::Failed,
        }
    }

    /// Opaque Work Session identity.
    pub fn session_id(&self) -> &WorkSessionId {
        match self {
            Self::Ready { session_id, .. }
            | Self::Leased { session_id, .. }
            | Self::Stopping { session_id, .. }
            | Self::Restored { session_id, .. }
            | Self::Failed { session_id, .. } => session_id,
        }
    }

    /// Immutable Work Challenge owning the session.
    pub fn challenge_id(&self) -> &ChallengeId {
        match self {
            Self::Ready { challenge_id, .. }
            | Self::Leased { challenge_id, .. }
            | Self::Stopping { challenge_id, .. }
            | Self::Restored { challenge_id, .. }
            | Self::Failed { challenge_id, .. } => challenge_id,
        }
    }

    /// Stable reason the active lease was ended.
    pub fn maybe_stop_reason(&self) -> Option<&str> {
        match self {
            Self::Stopping { reason, .. }
            | Self::Restored { reason, .. }
            | Self::Failed { reason, .. } => Some(reason.as_str()),
            Self::Ready { .. } | Self::Leased { .. } => None,
        }
    }

    /// Current monotonic lease, present only while the session is leased.
    pub fn maybe_lease(&self) -> Option<&WorkLease> {
        match self {
            Self::Leased { lease, .. } => Some(lease),
            _ => None,
        }
    }
}
