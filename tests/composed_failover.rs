use std::{error::Error, sync::Arc};

use bwg_core::{
    authority::{
        self, AuthorityApplication, AuthorityApplicationError, IssuanceProcessingOutcome,
        IssuanceWorkerId,
    },
    lifecycle::{SessionLifecycle, SessionLifecycleState, WorkLease, WorkerClock},
    pool_offer::{
        MaterialPoolOfferConfirmation, PoolFailoverProjection, PoolFailoverRecoveryCategory,
        PoolFailoverSessionState, PoolOfferReplacementStatus,
    },
    progress::AcceptedWorkAcknowledgement,
};
use serde_json::Value;

#[path = "support/authority_keys.rs"]
mod authority_key_support;
#[path = "support/composed_failover_phases.rs"]
mod composed_failover_phases;
#[path = "support/composed_failover.rs"]
mod composed_failover_support;
#[path = "support/postgres.rs"]
mod postgres_support;
#[path = "support/running_server.rs"]
mod running_server_support;
#[path = "support/trusted_consent_authority.rs"]
mod trusted_consent_authority_support;
#[path = "support/trusted_consent_verifier.rs"]
mod trusted_consent_verifier_support;
#[path = "support/work_session.rs"]
#[allow(dead_code)]
mod work_session_support;

use composed_failover_phases::{
    PendingJourney, arrange_equivalent_journey, prepare_pending_journey,
};
use composed_failover_support::{
    assert_failover_projection_is_metadata_only, assert_public_lifecycle_is_identity_free,
    complete_material_ceremony, fetch_lifecycle, signature_digest,
};
use running_server_support::RunningServer;
use trusted_consent_authority_support::authority_config;
use trusted_consent_verifier_support::FakeVerifier;
use work_session_support::accepted_event;

struct CompletionOutcome {
    pending: PendingJourney,
    recovered_confirmation: MaterialPoolOfferConfirmation,
    recovered_pending_projection: PoolFailoverProjection,
    recovered_progress: Value,
    wrong_release: Result<WorkLease, AuthorityApplicationError>,
    released_projection: PoolFailoverProjection,
    peer_result: AcceptedWorkAcknowledgement,
    material_result: AcceptedWorkAcknowledgement,
    public_lifecycle: Value,
    terminal_wrong_release: Result<WorkLease, AuthorityApplicationError>,
    peer_lifecycle: SessionLifecycle,
    material_lifecycle: SessionLifecycle,
    ready_lifecycle: SessionLifecycle,
    primary_lifecycle: SessionLifecycle,
    equivalent_lifecycle: SessionLifecycle,
    successor_lifecycle: SessionLifecycle,
    wrong_predecessor_lifecycle: SessionLifecycle,
    wrong_candidate_lifecycle: Result<SessionLifecycle, AuthorityApplicationError>,
    issued: IssuanceProcessingOutcome,
    repeated: IssuanceProcessingOutcome,
}

#[tokio::test]
async fn composed_failover_recovers_then_issues_once_and_stops_every_session()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let equivalent = arrange_equivalent_journey().await?;
    let pending = prepare_pending_journey(equivalent).await?;

    // Act
    let outcome = complete_recovered_journey(pending).await?;

    // Assert
    assert_composed_outcome(outcome)
}

async fn complete_recovered_journey(
    mut pending: PendingJourney,
) -> Result<CompletionOutcome, Box<dyn Error>> {
    pending
        .equivalent
        .maybe_server
        .take()
        .ok_or("Authority server")?
        .stop();
    let recovered_application =
        AuthorityApplication::connect_postgres_with_trusted_consent_verifier(
            authority_config()?,
            pending.equivalent.database.database_url(),
            Arc::new(FakeVerifier::default()),
        )
        .await?;
    let recovered_adapter = recovered_application.simulated_pool_adapter();
    let recovered_server = RunningServer::spawn(authority::router(recovered_application)).await?;
    let recovered_confirmation = recovered_adapter
        .prepare_material_pool_offer_confirmation(&pending.equivalent.successor_session)
        .await?;
    let recovered_pending_projection = recovered_adapter
        .pool_failover_projection(&pending.equivalent.successor_session)
        .await?;
    let recovered_progress =
        fetch_lifecycle(&recovered_server.base_url, &pending.equivalent.challenge_id).await?;
    let wrong_release = recovered_adapter
        .start_material_replacement_lease(
            &pending.equivalent.successor_session,
            WorkerClock::new("boot_composed_wrong_receipt_01", 0)?,
            &pending.wrong_receipt,
        )
        .await;
    let material_receipt = complete_material_ceremony(
        &recovered_server.base_url,
        &pending.equivalent.challenge_id,
        &signature_digest(&recovered_confirmation),
    )
    .await?;
    let material_lease = recovered_adapter
        .start_material_replacement_lease(
            &pending.equivalent.successor_session,
            WorkerClock::new("boot_composed_material_01", 0)?,
            &material_receipt,
        )
        .await?;
    let released_projection = recovered_adapter
        .pool_failover_projection(&pending.equivalent.successor_session)
        .await?;
    let (peer_result, material_result) = tokio::join!(
        recovered_adapter.report(
            accepted_event(
                "event_composed_peer_01",
                "share_composed_peer_01",
                pending.equivalent.peer.clone(),
                0x20,
                pending.equivalent.received_at + 2,
            )?,
            &pending.equivalent.peer_lease,
            WorkerClock::new("boot_composed_peer_01", 1)?,
        ),
        recovered_adapter.report(
            accepted_event(
                "event_composed_material_01",
                "share_composed_material_01",
                pending.material_session.clone(),
                0x20,
                pending.equivalent.received_at + 2,
            )?,
            &material_lease,
            WorkerClock::new("boot_composed_material_01", 1)?,
        ),
    );
    let peer_result = peer_result?;
    let material_result = material_result?;
    let public_lifecycle =
        fetch_lifecycle(&recovered_server.base_url, &pending.equivalent.challenge_id).await?;
    let terminal_wrong_release = recovered_adapter
        .start_material_replacement_lease(
            &pending.equivalent.wrong_terms_predecessor,
            WorkerClock::new("boot_composed_terminal_pending_01", 0)?,
            &pending.wrong_receipt,
        )
        .await;
    let peer_lifecycle = recovered_adapter
        .session_lifecycle(&pending.equivalent.peer)
        .await?;
    let material_lifecycle = recovered_adapter
        .session_lifecycle(&pending.material_session)
        .await?;
    let ready_lifecycle = recovered_adapter
        .session_lifecycle(&pending.equivalent.ready)
        .await?;
    let primary_lifecycle = recovered_adapter
        .session_lifecycle(&pending.equivalent.primary)
        .await?;
    let equivalent_lifecycle = recovered_adapter
        .session_lifecycle(&pending.equivalent.equivalent_session)
        .await?;
    let successor_lifecycle = recovered_adapter
        .session_lifecycle(&pending.equivalent.successor_session)
        .await?;
    let wrong_predecessor_lifecycle = recovered_adapter
        .session_lifecycle(&pending.equivalent.wrong_terms_predecessor)
        .await?;
    let wrong_candidate_lifecycle = recovered_adapter
        .session_lifecycle(&pending.wrong_terms_session)
        .await;
    recovered_server.stop();

    let issuance_application =
        AuthorityApplication::connect_postgres_with_trusted_consent_verifier(
            authority_config()?,
            pending.equivalent.database.database_url(),
            Arc::new(FakeVerifier::default()),
        )
        .await?;
    let worker = IssuanceWorkerId::try_from("worker_composed_failover_01".to_owned())?;
    let issued = issuance_application
        .process_next_issuance(&worker, pending.equivalent.received_at + 2)
        .await?;
    let repeated = issuance_application
        .process_next_issuance(&worker, pending.equivalent.received_at + 3)
        .await?;
    Ok(CompletionOutcome {
        pending,
        recovered_confirmation,
        recovered_pending_projection,
        recovered_progress,
        wrong_release,
        released_projection,
        peer_result,
        material_result,
        public_lifecycle,
        terminal_wrong_release,
        peer_lifecycle,
        material_lifecycle,
        ready_lifecycle,
        primary_lifecycle,
        equivalent_lifecycle,
        successor_lifecycle,
        wrong_predecessor_lifecycle,
        wrong_candidate_lifecycle,
        issued,
        repeated,
    })
}

fn assert_composed_outcome(outcome: CompletionOutcome) -> Result<(), Box<dyn Error>> {
    let equivalent = &outcome.pending.equivalent;
    assert_eq!(
        equivalent.equivalent_decision.status(),
        PoolOfferReplacementStatus::Equivalent
    );
    assert!(!equivalent.equivalent_lease.lease_id().is_empty());
    assert_eq!(
        equivalent.equivalent_projection.recovery_category(),
        PoolFailoverRecoveryCategory::AutomaticEquivalent
    );
    assert_eq!(
        equivalent.equivalent_projection.candidate_session().state(),
        PoolFailoverSessionState::Ready
    );
    assert_eq!(
        equivalent.equivalent_projection.current_offer().endpoint(),
        equivalent.equivalent_offer.endpoint()
    );
    assert_eq!(
        outcome.pending.material_decision.status(),
        PoolOfferReplacementStatus::PendingReconfirmation
    );
    assert_eq!(
        outcome.recovered_confirmation,
        outcome.pending.material_confirmation
    );
    assert_eq!(
        outcome.recovered_pending_projection,
        outcome.pending.pending_projection
    );
    assert_eq!(
        outcome.pending.pending_projection.current_offer(),
        &equivalent.equivalent_offer
    );
    assert!(matches!(
        outcome.wrong_release,
        Err(AuthorityApplicationError::InvalidTrustedConsentReceipt)
    ));
    assert_eq!(
        outcome.pending.pending_projection.recovery_category(),
        PoolFailoverRecoveryCategory::TrustedConfirmationRequired
    );
    assert_eq!(
        outcome
            .pending
            .pending_projection
            .candidate_session()
            .state(),
        PoolFailoverSessionState::PendingConfirmation
    );
    assert_eq!(
        outcome
            .pending
            .pending_projection
            .maybe_pending_offer()
            .ok_or("material offer should be pending")?,
        &outcome.pending.material_offer
    );
    assert_eq!(
        outcome.released_projection.recovery_category(),
        PoolFailoverRecoveryCategory::TrustedConfirmationAccepted
    );
    assert_eq!(
        outcome.released_projection.candidate_session().state(),
        PoolFailoverSessionState::Leased
    );
    assert_eq!(
        outcome.released_projection.current_offer(),
        &outcome.pending.material_offer
    );
    assert!(outcome.released_projection.maybe_pending_offer().is_none());
    assert_eq!(
        equivalent.initial.verified_progress().to_decimal_string(),
        "1099511627776"
    );
    let retained = equivalent
        .equivalent_progress
        .verified_progress()
        .to_decimal_string();
    assert_eq!(
        outcome.pending.progress_after_equivalent["verified_progress"],
        retained
    );
    assert_eq!(outcome.recovered_progress["verified_progress"], retained);
    assert_threshold_depends_on_retained_progress(
        &equivalent.challenge,
        &equivalent.equivalent_progress,
        &outcome.peer_result,
        &outcome.material_result,
    )?;
    assert_eq!(
        [
            outcome.peer_result.issuance_intent_created(),
            outcome.material_result.issuance_intent_created(),
        ]
        .into_iter()
        .filter(|created| *created)
        .count(),
        1
    );
    for lifecycle in [
        outcome.peer_lifecycle,
        outcome.material_lifecycle,
        outcome.ready_lifecycle,
    ] {
        assert_eq!(lifecycle.state(), SessionLifecycleState::Stopping);
        assert_eq!(lifecycle.maybe_stop_reason(), Some("challenge_satisfied"));
    }
    for lifecycle in [
        outcome.primary_lifecycle,
        outcome.equivalent_lifecycle,
        outcome.successor_lifecycle,
        outcome.wrong_predecessor_lifecycle,
    ] {
        assert!(!matches!(
            lifecycle.state(),
            SessionLifecycleState::Ready | SessionLifecycleState::Leased
        ));
    }
    assert!(matches!(
        outcome.wrong_candidate_lifecycle,
        Err(AuthorityApplicationError::UnknownWorkSession)
    ));
    assert!(matches!(
        outcome.terminal_wrong_release,
        Err(AuthorityApplicationError::ForbiddenLifecycleTransition)
    ));
    assert_eq!(outcome.public_lifecycle["state"], "satisfied");
    assert_eq!(
        outcome.issued,
        IssuanceProcessingOutcome::Issued {
            challenge_id: equivalent.challenge_id.clone(),
        }
    );
    assert_eq!(outcome.repeated, IssuanceProcessingOutcome::NoWork);
    assert_public_lifecycle_is_identity_free(
        &outcome.public_lifecycle,
        [
            &equivalent.primary,
            &equivalent.peer,
            &equivalent.ready,
            &equivalent.equivalent_session,
            &equivalent.successor_session,
            &outcome.pending.material_session,
            &equivalent.wrong_terms_predecessor,
            &outcome.pending.wrong_terms_session,
        ],
    )?;
    assert_failover_projection_is_metadata_only(&outcome.released_projection)
}

fn assert_threshold_depends_on_retained_progress(
    challenge: &Value,
    retained: &AcceptedWorkAcknowledgement,
    first: &AcceptedWorkAcknowledgement,
    second: &AcceptedWorkAcknowledgement,
) -> Result<(), Box<dyn Error>> {
    let retained_progress = retained
        .verified_progress()
        .to_decimal_string()
        .parse::<u64>()?;
    let first_credit = first
        .maybe_credited_work()
        .ok_or("first work should be credited")?
        .to_decimal_string()
        .parse::<u64>()?;
    let second_credit = second
        .maybe_credited_work()
        .ok_or("second work should be credited")?
        .to_decimal_string()
        .parse::<u64>()?;
    let requirement = challenge["work_requirement"]["expected_hashes"]
        .as_str()
        .ok_or("expected hash requirement")?
        .parse::<u64>()?;
    assert!(first_credit + second_credit < requirement);
    assert!(retained_progress + first_credit + second_credit >= requirement);
    Ok(())
}
