use std::{
    error::Error,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use bwg_core::{
    authority::{self, AuthorityApplication, SimulatedPoolAdapter},
    challenge::{ActionPolicy, ChallengeId},
    lifecycle::{WorkLease, WorkerClock, WorkerInterruption},
    pool_offer::{
        MaterialPoolOfferConfirmation, PoolFailoverProjection, PoolOffer,
        PoolOfferReplacementDecision,
    },
    progress::{AcceptedWorkAcknowledgement, WorkSessionId},
};
use serde_json::{Value, json};

use crate::{
    composed_failover_support::{complete_material_ceremony, fetch_lifecycle, signature_digest},
    postgres_support::PostgresTestDatabase,
    running_server_support::RunningServer,
    trusted_consent_authority_support::{authority_config, issue_challenge},
    trusted_consent_verifier_support::FakeVerifier,
    work_session_support::accepted_event,
};

pub(crate) struct EquivalentJourney {
    pub database: PostgresTestDatabase,
    pub adapter: SimulatedPoolAdapter,
    pub maybe_server: Option<RunningServer>,
    pub challenge: Value,
    pub challenge_id: ChallengeId,
    pub primary: WorkSessionId,
    pub peer: WorkSessionId,
    pub ready: WorkSessionId,
    pub wrong_terms_predecessor: WorkSessionId,
    pub peer_lease: WorkLease,
    pub received_at: u64,
    pub initial: AcceptedWorkAcknowledgement,
    pub equivalent_offer: PoolOffer,
    pub equivalent_session: WorkSessionId,
    pub equivalent_lease: WorkLease,
    pub equivalent_decision: PoolOfferReplacementDecision,
    pub equivalent_projection: PoolFailoverProjection,
    pub equivalent_progress: AcceptedWorkAcknowledgement,
    pub successor_session: WorkSessionId,
}

pub(crate) struct PendingJourney {
    pub equivalent: EquivalentJourney,
    pub material_offer: PoolOffer,
    pub material_session: WorkSessionId,
    pub material_decision: PoolOfferReplacementDecision,
    pub material_confirmation: MaterialPoolOfferConfirmation,
    pub wrong_terms_session: WorkSessionId,
    pub wrong_receipt: String,
    pub pending_projection: PoolFailoverProjection,
    pub progress_after_equivalent: Value,
}

pub(crate) async fn arrange_equivalent_journey() -> Result<EquivalentJourney, Box<dyn Error>> {
    let database = PostgresTestDatabase::start().await?;
    let application = AuthorityApplication::connect_postgres_with_trusted_consent_verifier(
        authority_config()?,
        database.database_url(),
        Arc::new(FakeVerifier::default()),
    )
    .await?;
    let adapter = application.simulated_pool_adapter();
    let server = RunningServer::spawn(authority::router(application)).await?;
    let challenge = issue_challenge(
        &server.base_url,
        ActionPolicy::ACCOUNT_CREATION_STANDARD_V1,
        "action_composed_failover_01",
    )
    .await?;
    let challenge_id = challenge_id(&challenge)?;
    adapter
        .consent_default_pool_offer_for_simulation(&challenge_id)
        .await?;
    let primary = session("session_composed_primary_01")?;
    let peer = session("session_composed_peer_01")?;
    let ready = session("session_composed_ready_01")?;
    let wrong_terms_predecessor = session("session_composed_wrong_terms_old_01")?;
    for session_id in [&primary, &peer, &ready, &wrong_terms_predecessor] {
        adapter
            .register_session(&challenge_id, session_id.clone())
            .await?;
    }
    let primary_lease = adapter
        .start_lease(&primary, WorkerClock::new("boot_composed_primary_01", 0)?)
        .await?;
    let peer_lease = adapter
        .start_lease(&peer, WorkerClock::new("boot_composed_peer_01", 0)?)
        .await?;
    let received_at = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let initial = adapter
        .report(
            accepted_event(
                "event_composed_initial_01",
                "share_composed_initial_01",
                primary.clone(),
                0xff,
                received_at,
            )?,
            &primary_lease,
            WorkerClock::new("boot_composed_primary_01", 1)?,
        )
        .await?;
    interrupt_across_database_pause(&database, &adapter, &primary).await?;

    let mut equivalent_json = challenge["pool_offers"]["offers"][0].clone();
    equivalent_json["endpoint"] = json!("stratum+tcp://failover.example:3333/");
    let equivalent_offer = serde_json::from_value::<PoolOffer>(equivalent_json)?;
    let signed_equivalent = adapter
        .sign_pool_offer_set_for_simulation(&challenge_id, vec![equivalent_offer.clone()], false)
        .await?;
    let equivalent_session = session("session_composed_equivalent_01")?;
    let equivalent_decision = adapter
        .replace_pool_offer(&primary, equivalent_session.clone(), &signed_equivalent)
        .await?;
    let equivalent_projection = adapter.pool_failover_projection(&primary).await?;
    let equivalent_lease = adapter
        .start_lease(
            &equivalent_session,
            WorkerClock::new("boot_composed_equivalent_01", 0)?,
        )
        .await?;
    let equivalent_progress = adapter
        .report(
            accepted_event(
                "event_composed_equivalent_01",
                "share_composed_equivalent_01",
                equivalent_session.clone(),
                0xff,
                received_at + 1,
            )?,
            &equivalent_lease,
            WorkerClock::new("boot_composed_equivalent_01", 1)?,
        )
        .await?;
    adapter
        .interrupt(
            &equivalent_session,
            WorkerInterruption::TransportDisconnected,
        )
        .await?;
    let successor_session = session("session_composed_successor_01")?;
    adapter
        .replace_session(&equivalent_session, successor_session.clone())
        .await?;
    adapter
        .start_lease(
            &successor_session,
            WorkerClock::new("boot_composed_successor_01", 0)?,
        )
        .await?;
    adapter
        .interrupt(
            &successor_session,
            WorkerInterruption::TransportDisconnected,
        )
        .await?;

    Ok(EquivalentJourney {
        database,
        adapter,
        maybe_server: Some(server),
        challenge,
        challenge_id,
        primary,
        peer,
        ready,
        wrong_terms_predecessor,
        peer_lease,
        received_at,
        initial,
        equivalent_offer,
        equivalent_session,
        equivalent_lease,
        equivalent_decision,
        equivalent_projection,
        equivalent_progress,
        successor_session,
    })
}

pub(crate) async fn prepare_pending_journey(
    equivalent: EquivalentJourney,
) -> Result<PendingJourney, Box<dyn Error>> {
    let server = equivalent.maybe_server.as_ref().ok_or("Authority server")?;
    let mut material_json = serde_json::to_value(&equivalent.equivalent_offer)?;
    material_json["reward_policy"]["selected_destination_basis_points"] = json!(9_900);
    material_json["reward_policy"]["pool_fee_basis_points"] = json!(100);
    let material_offer = serde_json::from_value::<PoolOffer>(material_json)?;
    let signed_material = equivalent
        .adapter
        .sign_pool_offer_set_for_simulation(
            &equivalent.challenge_id,
            vec![material_offer.clone()],
            false,
        )
        .await?;
    let material_session = session("session_composed_material_01")?;
    let material_decision = equivalent
        .adapter
        .replace_pool_offer(
            &equivalent.successor_session,
            material_session.clone(),
            &signed_material,
        )
        .await?;
    let material_confirmation = equivalent
        .adapter
        .prepare_material_pool_offer_confirmation(&equivalent.successor_session)
        .await?;
    equivalent
        .adapter
        .fail_session(&equivalent.wrong_terms_predecessor)
        .await?;
    let mut wrong_terms = equivalent.challenge["pool_offers"]["offers"][0].clone();
    wrong_terms["privacy_terms_url"] = json!("https://authority.example/privacy-v2");
    let signed_wrong_terms = equivalent
        .adapter
        .sign_pool_offer_set_for_simulation(
            &equivalent.challenge_id,
            vec![serde_json::from_value(wrong_terms)?],
            false,
        )
        .await?;
    let wrong_terms_session = session("session_composed_wrong_terms_new_01")?;
    equivalent
        .adapter
        .replace_pool_offer(
            &equivalent.wrong_terms_predecessor,
            wrong_terms_session.clone(),
            &signed_wrong_terms,
        )
        .await?;
    let wrong_confirmation = equivalent
        .adapter
        .prepare_material_pool_offer_confirmation(&equivalent.wrong_terms_predecessor)
        .await?;
    let wrong_receipt = complete_material_ceremony(
        &server.base_url,
        &equivalent.challenge_id,
        &signature_digest(&wrong_confirmation),
    )
    .await?;
    let pending_projection = equivalent
        .adapter
        .pool_failover_projection(&equivalent.successor_session)
        .await?;
    let progress_after_equivalent =
        fetch_lifecycle(&server.base_url, &equivalent.challenge_id).await?;
    Ok(PendingJourney {
        equivalent,
        material_offer,
        material_session,
        material_decision,
        material_confirmation,
        wrong_terms_session,
        wrong_receipt,
        pending_projection,
        progress_after_equivalent,
    })
}

async fn interrupt_across_database_pause(
    database: &PostgresTestDatabase,
    adapter: &SimulatedPoolAdapter,
    session_id: &WorkSessionId,
) -> Result<(), Box<dyn Error>> {
    database.pause().await?;
    let interrupted_adapter = adapter.clone();
    let interrupted_session = session_id.clone();
    let interruption = tokio::spawn(async move {
        interrupted_adapter
            .interrupt(
                &interrupted_session,
                WorkerInterruption::TransportDisconnected,
            )
            .await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!interruption.is_finished());
    database.resume().await?;
    interruption.await??;
    Ok(())
}

fn challenge_id(challenge: &Value) -> Result<ChallengeId, Box<dyn Error>> {
    Ok(ChallengeId::try_from(
        challenge["challenge_id"]
            .as_str()
            .ok_or("challenge ID")?
            .to_owned(),
    )?)
}

fn session(value: &str) -> Result<WorkSessionId, Box<dyn Error>> {
    Ok(WorkSessionId::try_from(value.to_owned())?)
}
