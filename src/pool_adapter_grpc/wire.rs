//! Conversions between domain values and `bwg.pool_adapter.v1` messages.
//!
//! Every inbound message is parsed back into domain types, so each side applies
//! the same validation it applies in process.

use thiserror::Error;
use tonic::Status;

use super::proto;
use crate::{
    authority::PoolSelectionIntake,
    challenge::ChallengeId,
    pool_offer::PoolSelection,
    progress::{
        AcceptedWorkEvent, AcceptedWorkEventId, AcceptedWorkEventInput, AcceptedWorkRefusal,
        NetworkTargetOutcome, ReceiptTime, ShareFingerprint, WorkSessionId,
    },
    stratum_v1::{StratumLeaseContext, WorkerStratumLease},
};

/// An inbound message that does not parse into its domain value.
#[derive(Debug, Error)]
#[error("{0} is missing or invalid")]
pub(super) struct WireError(&'static str);

impl From<WireError> for Status {
    fn from(error: WireError) -> Self {
        Status::invalid_argument(error.to_string())
    }
}

/// The wire reason for one refusal; the enum's order is the vectors' order.
pub fn refusal_to_wire(refusal: AcceptedWorkRefusal) -> proto::AcceptedWorkRefusalReason {
    use proto::AcceptedWorkRefusalReason as Wire;
    match refusal {
        AcceptedWorkRefusal::UnknownWorkLease => Wire::UnknownWorkLease,
        AcceptedWorkRefusal::WorkLeaseEnded => Wire::WorkLeaseEnded,
        AcceptedWorkRefusal::WorkerContinuityLost => Wire::WorkerContinuityLost,
        AcceptedWorkRefusal::WorkLeaseExpired => Wire::WorkLeaseExpired,
        AcceptedWorkRefusal::ChallengeSatisfied => Wire::ChallengeSatisfied,
        AcceptedWorkRefusal::ChallengeCancelled => Wire::ChallengeCancelled,
        AcceptedWorkRefusal::ChallengeDeadlinePassed => Wire::ChallengeDeadlinePassed,
        AcceptedWorkRefusal::ConflictingEventReplay => Wire::ConflictingEventReplay,
    }
}

/// The refusal a wire reason names, or `None` for one this build does not know.
pub fn refusal_from_wire(reason: i32) -> Option<AcceptedWorkRefusal> {
    use proto::AcceptedWorkRefusalReason as Wire;
    match Wire::try_from(reason).ok()? {
        Wire::Unspecified => None,
        Wire::UnknownWorkLease => Some(AcceptedWorkRefusal::UnknownWorkLease),
        Wire::WorkLeaseEnded => Some(AcceptedWorkRefusal::WorkLeaseEnded),
        Wire::WorkerContinuityLost => Some(AcceptedWorkRefusal::WorkerContinuityLost),
        Wire::WorkLeaseExpired => Some(AcceptedWorkRefusal::WorkLeaseExpired),
        Wire::ChallengeSatisfied => Some(AcceptedWorkRefusal::ChallengeSatisfied),
        Wire::ChallengeCancelled => Some(AcceptedWorkRefusal::ChallengeCancelled),
        Wire::ChallengeDeadlinePassed => Some(AcceptedWorkRefusal::ChallengeDeadlinePassed),
        Wire::ConflictingEventReplay => Some(AcceptedWorkRefusal::ConflictingEventReplay),
    }
}

pub(super) fn lease_context_to_wire(context: &StratumLeaseContext) -> proto::StratumLeaseContext {
    proto::StratumLeaseContext {
        lease_id: context.lease_id().to_owned(),
        continuity_id: context.continuity_id().to_owned(),
        last_monotonic_milliseconds: context.last_monotonic_milliseconds(),
        renew_at_monotonic_milliseconds: context.renew_at_monotonic_milliseconds(),
        expires_at_monotonic_milliseconds: context.expires_at_monotonic_milliseconds(),
    }
}

pub(super) fn lease_context_from_wire(
    maybe_context: Option<proto::StratumLeaseContext>,
) -> Result<StratumLeaseContext, WireError> {
    let Some(context) = maybe_context else {
        return Err(WireError("lease_context"));
    };
    StratumLeaseContext::new(
        context.lease_id,
        context.continuity_id,
        context.last_monotonic_milliseconds,
        context.renew_at_monotonic_milliseconds,
        context.expires_at_monotonic_milliseconds,
    )
    .map_err(|_| WireError("lease_context"))
}

pub(super) fn event_to_wire(event: &AcceptedWorkEvent) -> proto::AcceptedWorkEvent {
    let outcome = match event.network_target_outcome() {
        NetworkTargetOutcome::BelowNetworkTarget => proto::NetworkTargetOutcome::BelowNetworkTarget,
        NetworkTargetOutcome::NetworkTargetMet => proto::NetworkTargetOutcome::NetworkTargetMet,
    };
    proto::AcceptedWorkEvent {
        event_id: event.event_id().as_str().to_owned(),
        work_session_id: event.work_session_id().as_str().to_owned(),
        assigned_target: event.assigned_target_be_bytes().to_vec(),
        received_at_unix_seconds: event.received_at_unix_seconds(),
        share_fingerprint: event.share_fingerprint().as_str().to_owned(),
        network_target_outcome: outcome.into(),
    }
}

pub(super) fn event_from_wire(
    maybe_event: Option<proto::AcceptedWorkEvent>,
) -> Result<AcceptedWorkEvent, WireError> {
    let Some(event) = maybe_event else {
        return Err(WireError("event"));
    };
    let network_target_outcome =
        match proto::NetworkTargetOutcome::try_from(event.network_target_outcome) {
            Ok(proto::NetworkTargetOutcome::BelowNetworkTarget) => {
                NetworkTargetOutcome::BelowNetworkTarget
            }
            Ok(proto::NetworkTargetOutcome::NetworkTargetMet) => {
                NetworkTargetOutcome::NetworkTargetMet
            }
            _ => return Err(WireError("network_target_outcome")),
        };
    let assigned_target = <[u8; 32]>::try_from(event.assigned_target.as_slice())
        .map_err(|_| WireError("assigned_target"))?;
    AcceptedWorkEvent::try_from(AcceptedWorkEventInput {
        event_id: AcceptedWorkEventId::try_from(event.event_id)
            .map_err(|_| WireError("event_id"))?,
        work_session_id: session_id_from_wire(event.work_session_id)?,
        assigned_target,
        received_at: ReceiptTime::try_from(event.received_at_unix_seconds)
            .map_err(|_| WireError("received_at_unix_seconds"))?,
        share_fingerprint: ShareFingerprint::try_from(event.share_fingerprint)
            .map_err(|_| WireError("share_fingerprint"))?,
        network_target_outcome,
        maybe_worker_report: None,
    })
    .map_err(|_| WireError("event"))
}

pub(super) fn session_id_from_wire(value: String) -> Result<WorkSessionId, WireError> {
    WorkSessionId::try_from(value).map_err(|_| WireError("work_session_id"))
}

pub(super) fn challenge_id_from_wire(value: String) -> Result<ChallengeId, WireError> {
    ChallengeId::try_from(value).map_err(|_| WireError("challenge_id"))
}

pub(super) fn worker_lease_to_wire(lease: &WorkerStratumLease) -> proto::WorkerStratumLease {
    proto::WorkerStratumLease {
        work_session_id: lease.session_id.as_str().to_owned(),
        lease_context: Some(lease_context_to_wire(&lease.lease_context)),
        now_unix_milliseconds: lease.now_unix_milliseconds,
        lease_expires_at_unix_seconds: lease.lease_expires_at_unix_seconds,
        challenge_expires_at_unix_seconds: lease.challenge_expires_at_unix_seconds,
    }
}

pub(super) fn worker_lease_from_wire(
    maybe_lease: Option<proto::WorkerStratumLease>,
) -> Result<WorkerStratumLease, WireError> {
    let Some(lease) = maybe_lease else {
        return Err(WireError("lease"));
    };
    Ok(WorkerStratumLease {
        session_id: session_id_from_wire(lease.work_session_id)?,
        lease_context: lease_context_from_wire(lease.lease_context)?,
        now_unix_milliseconds: lease.now_unix_milliseconds,
        lease_expires_at_unix_seconds: lease.lease_expires_at_unix_seconds,
        challenge_expires_at_unix_seconds: lease.challenge_expires_at_unix_seconds,
    })
}

pub(super) fn pool_selection_to_wire(
    intake: &PoolSelectionIntake,
) -> proto::RecordPoolSelectionRequest {
    use proto::record_pool_selection_request::Payout;
    let destination = intake.selection.payout_destination().to_owned();
    let payout = match intake.selection.payout_destination_type() {
        "bitcoin_mainnet_address" => Payout::BitcoinMainnetAddress(destination),
        _ => Payout::ApprovedBeneficiaryId(destination),
    };
    proto::RecordPoolSelectionRequest {
        work_session_id: intake.session_id.as_str().to_owned(),
        challenge_id: intake.challenge_id.as_str().to_owned(),
        pool_offer_id: intake.selection.offer_id().to_owned(),
        payout: Some(payout),
        challenge_expires_at_unix_seconds: intake.challenge_expires_at_unix_seconds,
        now_unix_seconds: intake.now_unix_seconds,
    }
}

pub(super) fn pool_selection_from_wire(
    request: proto::RecordPoolSelectionRequest,
) -> Result<PoolSelectionIntake, WireError> {
    use proto::record_pool_selection_request::Payout;
    let selection = match request.payout {
        Some(Payout::BitcoinMainnetAddress(address)) => {
            PoolSelection::bitcoin_address(request.pool_offer_id, address)
        }
        Some(Payout::ApprovedBeneficiaryId(beneficiary)) => {
            PoolSelection::approved_beneficiary(request.pool_offer_id, beneficiary)
        }
        None => return Err(WireError("payout")),
    }
    .map_err(|_| WireError("payout"))?;
    Ok(PoolSelectionIntake {
        session_id: session_id_from_wire(request.work_session_id)?,
        challenge_id: challenge_id_from_wire(request.challenge_id)?,
        selection,
        challenge_expires_at_unix_seconds: request.challenge_expires_at_unix_seconds,
        now_unix_seconds: request.now_unix_seconds,
    })
}

#[cfg(test)]
mod tests;
