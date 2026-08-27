use std::error::Error;

use bwg_core::{
    lifecycle::WorkLease,
    progress::{
        AcceptedWorkEvent, AcceptedWorkEventId, AcceptedWorkEventInput, NetworkTargetOutcome,
        ReceiptTime, ShareFingerprint, WorkSessionId,
    },
    stratum_v1::{StratumCredentialIssuer, StratumLeaseContext, StratumSessionCredentials},
};

pub(crate) fn accepted_event(
    event_id: &str,
    share_fingerprint: &str,
    session_id: WorkSessionId,
    target_marker: u8,
    received_at: u64,
) -> Result<AcceptedWorkEvent, Box<dyn Error>> {
    let mut assigned_target = [0xff_u8; 32];
    assigned_target[..5].fill(0);
    assigned_target[5] = target_marker;
    Ok(AcceptedWorkEvent::try_from(AcceptedWorkEventInput {
        event_id: AcceptedWorkEventId::try_from(event_id.to_owned())?,
        work_session_id: session_id,
        assigned_target,
        received_at: ReceiptTime::try_from(received_at)?,
        share_fingerprint: ShareFingerprint::try_from(share_fingerprint.to_owned())?,
        network_target_outcome: NetworkTargetOutcome::BelowNetworkTarget,
        maybe_worker_report: None,
    })?)
}

pub(crate) fn stratum_credentials(
    issuer: &StratumCredentialIssuer,
    session_id: WorkSessionId,
    lease: &WorkLease,
    continuity_id: &str,
    now: u64,
    challenge_expires_at: u64,
) -> Result<StratumSessionCredentials, Box<dyn Error>> {
    let lease_context = StratumLeaseContext::new(
        lease.lease_id().to_owned(),
        continuity_id.to_owned(),
        0,
        lease.renew_at_monotonic_milliseconds(),
        lease.expires_at_monotonic_milliseconds(),
    )?;
    Ok(issuer.issue(
        session_id,
        lease_context,
        now,
        now.checked_add(60).ok_or("lease expiry overflow")?,
        challenge_expires_at,
    )?)
}
