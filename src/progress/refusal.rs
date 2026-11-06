use serde::{Deserialize, Serialize};

/// Why the Authority will never credit one Accepted Work Event (ADR-0108).
///
/// A refusal is terminal: delivery records it once and stops retrying.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcceptedWorkRefusal {
    UnknownWorkLease,
    WorkLeaseEnded,
    WorkerContinuityLost,
    WorkLeaseExpired,
    ChallengeSatisfied,
    ChallengeCancelled,
    ChallengeDeadlinePassed,
    ConflictingEventReplay,
}

impl AcceptedWorkRefusal {
    /// Every reason, in the order of the shared conformance vectors.
    pub const ALL: [Self; 8] = [
        Self::UnknownWorkLease,
        Self::WorkLeaseEnded,
        Self::WorkerContinuityLost,
        Self::WorkLeaseExpired,
        Self::ChallengeSatisfied,
        Self::ChallengeCancelled,
        Self::ChallengeDeadlinePassed,
        Self::ConflictingEventReplay,
    ];

    /// The stable reason code every wire adapter carries.
    pub fn code(self) -> &'static str {
        match self {
            Self::UnknownWorkLease => "unknown_work_lease",
            Self::WorkLeaseEnded => "work_lease_ended",
            Self::WorkerContinuityLost => "worker_continuity_lost",
            Self::WorkLeaseExpired => "work_lease_expired",
            Self::ChallengeSatisfied => "challenge_satisfied",
            Self::ChallengeCancelled => "challenge_cancelled",
            Self::ChallengeDeadlinePassed => "challenge_deadline_passed",
            Self::ConflictingEventReplay => "conflicting_event_replay",
        }
    }
}
