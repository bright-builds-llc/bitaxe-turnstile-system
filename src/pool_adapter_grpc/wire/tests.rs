use std::error::Error;

use super::{
    event_from_wire, event_to_wire, lease_context_from_wire, lease_context_to_wire,
    pool_selection_from_wire, pool_selection_to_wire, refusal_from_wire, refusal_to_wire,
    worker_lease_from_wire, worker_lease_to_wire,
};
use crate::{
    authority::PoolSelectionIntake,
    challenge::ChallengeId,
    pool_adapter_grpc::proto,
    pool_offer::PoolSelection,
    progress::{
        AcceptedWorkEvent, AcceptedWorkEventId, AcceptedWorkEventInput, AcceptedWorkRefusal,
        NetworkTargetOutcome, ReceiptTime, ShareFingerprint, WorkSessionId,
    },
    stratum_v1::{StratumLeaseContext, WorkerStratumLease},
};

fn event() -> Result<AcceptedWorkEvent, Box<dyn Error>> {
    let mut assigned_target = [0_u8; 32];
    assigned_target[4] = 0xff;
    assigned_target[5] = 0xff;
    Ok(AcceptedWorkEvent::try_from(AcceptedWorkEventInput {
        event_id: AcceptedWorkEventId::try_from("event_wire_01".to_owned())?,
        work_session_id: WorkSessionId::try_from("session_wire_01".to_owned())?,
        assigned_target,
        received_at: ReceiptTime::try_from(1_700_000_000)?,
        share_fingerprint: ShareFingerprint::try_from("share_wire_01".to_owned())?,
        network_target_outcome: NetworkTargetOutcome::NetworkTargetMet,
        maybe_worker_report: None,
    })?)
}

fn lease_context() -> Result<StratumLeaseContext, Box<dyn Error>> {
    Ok(StratumLeaseContext::new(
        "6f1c2d4e-8a9b-4c3d-9e2f-0a1b2c3d4e5f".to_owned(),
        "boot_wire_01".to_owned(),
        1_000,
        31_000,
        61_000,
    )?)
}

fn intake(selection: PoolSelection) -> Result<PoolSelectionIntake, Box<dyn Error>> {
    Ok(PoolSelectionIntake {
        session_id: WorkSessionId::try_from("session_wire_01".to_owned())?,
        challenge_id: ChallengeId::try_from("challenge_wire01".to_owned())?,
        selection,
        challenge_expires_at_unix_seconds: 1_700_000_300,
        now_unix_seconds: 1_700_000_000,
    })
}

#[test]
fn every_refusal_round_trips_through_its_wire_reason() {
    // Act
    let round_tripped: Vec<Option<AcceptedWorkRefusal>> = AcceptedWorkRefusal::ALL
        .iter()
        .map(|refusal| refusal_from_wire(refusal_to_wire(*refusal).into()))
        .collect();

    // Assert
    let expected: Vec<Option<AcceptedWorkRefusal>> =
        AcceptedWorkRefusal::ALL.iter().copied().map(Some).collect();
    assert_eq!(round_tripped, expected);
}

#[test]
fn unspecified_and_unknown_reasons_name_no_refusal() {
    // Act
    let unspecified = refusal_from_wire(proto::AcceptedWorkRefusalReason::Unspecified.into());
    let unknown = refusal_from_wire(99);

    // Assert
    assert_eq!((unspecified, unknown), (None, None));
}

#[test]
fn event_round_trips_through_the_wire() -> Result<(), Box<dyn Error>> {
    // Arrange
    let event = event()?;

    // Act
    let parsed = event_from_wire(Some(event_to_wire(&event)))?;

    // Assert
    assert_eq!(parsed, event);
    Ok(())
}

#[test]
fn event_with_a_short_target_is_refused() -> Result<(), Box<dyn Error>> {
    // Arrange
    let mut wire = event_to_wire(&event()?);
    wire.assigned_target.pop();

    // Act
    let refused = event_from_wire(Some(wire));

    // Assert
    assert!(refused.is_err());
    Ok(())
}

#[test]
fn event_with_an_unspecified_outcome_is_refused() -> Result<(), Box<dyn Error>> {
    // Arrange
    let mut wire = event_to_wire(&event()?);
    wire.network_target_outcome = proto::NetworkTargetOutcome::Unspecified.into();

    // Act
    let refused = event_from_wire(Some(wire));

    // Assert
    assert!(refused.is_err());
    Ok(())
}

#[test]
fn missing_event_is_refused() {
    // Act
    let refused = event_from_wire(None);

    // Assert
    assert!(refused.is_err());
}

#[test]
fn lease_context_round_trips_through_the_wire() -> Result<(), Box<dyn Error>> {
    // Arrange
    let context = lease_context()?;

    // Act
    let parsed = lease_context_from_wire(Some(lease_context_to_wire(&context)))?;

    // Assert
    assert_eq!(parsed, context);
    Ok(())
}

#[test]
fn worker_lease_round_trips_through_the_wire() -> Result<(), Box<dyn Error>> {
    // Arrange
    let lease = WorkerStratumLease {
        session_id: WorkSessionId::try_from("session_wire_01".to_owned())?,
        lease_context: lease_context()?,
        now_unix_milliseconds: 1_700_000_000_123,
        lease_expires_at_unix_seconds: 1_700_000_060,
        challenge_expires_at_unix_seconds: 1_700_000_300,
    };

    // Act
    let parsed = worker_lease_from_wire(Some(worker_lease_to_wire(&lease)))?;

    // Assert
    assert_eq!(parsed, lease);
    Ok(())
}

#[test]
fn bitcoin_address_selection_round_trips_through_the_wire() -> Result<(), Box<dyn Error>> {
    // Arrange
    let selection = PoolSelection::bitcoin_address(
        "pool_offer_hydra_solo_v1".to_owned(),
        "1BoatSLRHtKNngkdXEeobR76b53LETtpyT".to_owned(),
    )?;
    let intake = intake(selection.clone())?;

    // Act
    let parsed = pool_selection_from_wire(pool_selection_to_wire(&intake))?;

    // Assert
    assert!(parsed.selection == selection);
    assert_eq!(
        (parsed.session_id, parsed.challenge_id),
        (intake.session_id, intake.challenge_id)
    );
    assert_eq!(
        (
            parsed.challenge_expires_at_unix_seconds,
            parsed.now_unix_seconds
        ),
        (1_700_000_300, 1_700_000_000)
    );
    Ok(())
}

#[test]
fn approved_beneficiary_selection_round_trips_through_the_wire() -> Result<(), Box<dyn Error>> {
    // Arrange
    let selection = PoolSelection::approved_beneficiary(
        "pool_offer_hydra_solo_v1".to_owned(),
        "beneficiary_wire_01".to_owned(),
    )?;

    // Act
    let parsed = pool_selection_from_wire(pool_selection_to_wire(&intake(selection.clone())?))?;

    // Assert
    assert!(parsed.selection == selection);
    Ok(())
}

#[test]
fn selection_without_a_payout_is_refused() -> Result<(), Box<dyn Error>> {
    // Arrange
    let selection = PoolSelection::approved_beneficiary(
        "pool_offer_hydra_solo_v1".to_owned(),
        "beneficiary_wire_01".to_owned(),
    )?;
    let mut wire = pool_selection_to_wire(&intake(selection)?);
    wire.payout = None;

    // Act
    let refused = pool_selection_from_wire(wire);

    // Assert
    assert!(refused.is_err());
    Ok(())
}
