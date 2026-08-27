use std::error::Error;

use bwg_core::{
    authority::{
        AuthorityApplication, AuthorityApplicationError, AuthorityPublicConfig, CLIENT_ID_HEADER,
        Config, DeploymentEnvironment, ServiceCredential,
    },
    challenge::{ActionPolicy, ChallengeId},
    lifecycle::WorkerClock,
    pool_offer::{
        MaterialPoolOfferChange, PoolFailoverRecoveryCategory, PoolFailoverSessionState, PoolOffer,
        PoolOfferChange, PoolOfferReplacementStatus,
    },
    progress::WorkSessionId,
};
use serde_json::{Value, json};

#[path = "support/authority_keys.rs"]
mod authority_key_support;
#[path = "support/postgres.rs"]
mod postgres_support;
#[path = "support/running_server.rs"]
mod running_server_support;

use authority_key_support::{CLAIMANT_PUBLIC_JWK, authority_keys};
use postgres_support::PostgresTestDatabase;
use running_server_support::RunningServer;

const CLIENT_ID: &str = "pool-failover-reference-service";
const SERVICE_SECRET: &str = "pool-failover-secret-P9vK2mQ7xR4tY8uN3cF6wL1zA5dH0sJ";
const AUTHORITY_SIGNING_SEED: &str = "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A";
type OfferMutation = fn(&mut Value);

#[tokio::test]
async fn failover_projection_exposes_pending_material_terms() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let adapter = application.simulated_pool_adapter();
    let server = RunningServer::spawn(bwg_core::authority::router(application)).await?;
    let challenge = issue_challenge(&server.base_url, "action_failover_projection_01").await?;
    let challenge_id = ChallengeId::try_from(
        challenge["challenge_id"]
            .as_str()
            .ok_or("challenge ID")?
            .to_owned(),
    )?;
    adapter
        .consent_default_pool_offer_for_simulation(&challenge_id)
        .await?;
    let predecessor = WorkSessionId::try_from("session_projection_old_01".to_owned())?;
    adapter
        .register_session(&challenge_id, predecessor.clone())
        .await?;
    adapter.fail_session(&predecessor).await?;
    let mut candidate_json = challenge["pool_offers"]["offers"][0].clone();
    candidate_json["privacy_terms_url"] = json!("https://authority.example/privacy-v2");
    let candidate = serde_json::from_value::<PoolOffer>(candidate_json)?;
    let candidate_offer_id = candidate.offer_id().to_owned();
    let signed = adapter
        .sign_pool_offer_set_for_simulation(&challenge_id, vec![candidate], false)
        .await?;
    let candidate_session = WorkSessionId::try_from("session_projection_new_01".to_owned())?;
    adapter
        .replace_pool_offer(&predecessor, candidate_session.clone(), &signed)
        .await?;

    // Act
    let pending = adapter.pool_failover_projection(&predecessor).await?;

    // Assert
    assert_eq!(
        pending.recovery_category(),
        PoolFailoverRecoveryCategory::TrustedConfirmationRequired
    );
    assert_eq!(
        pending.candidate_session().state(),
        PoolFailoverSessionState::PendingConfirmation
    );
    assert_eq!(
        pending
            .maybe_pending_offer()
            .ok_or("pending offer")?
            .offer_id(),
        candidate_offer_id
    );
    assert_eq!(
        pending.current_offer().privacy_terms_url(),
        "https://authority.example/privacy"
    );
    assert_eq!(pending.challenge_id(), &challenge_id);
    server.stop();
    Ok(())
}

#[tokio::test]
async fn signed_endpoint_only_candidate_releases_one_equivalent_replacement()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let adapter = application.simulated_pool_adapter();
    let server = RunningServer::spawn(bwg_core::authority::router(application)).await?;
    let challenge = issue_challenge(&server.base_url, "action_equivalent_failover_01").await?;
    let challenge_id = ChallengeId::try_from(
        challenge["challenge_id"]
            .as_str()
            .ok_or("challenge response needs an identifier")?
            .to_owned(),
    )?;
    adapter
        .consent_default_pool_offer_for_simulation(&challenge_id)
        .await?;
    let predecessor = WorkSessionId::try_from("session_failover_predecessor_01".to_owned())?;
    adapter
        .register_session(&challenge_id, predecessor.clone())
        .await?;
    adapter.fail_session(&predecessor).await?;
    let mut candidate_json = challenge["pool_offers"]["offers"][0].clone();
    candidate_json["endpoint"] = json!("stratum+tcp://failover.example:3333/");
    let mut backup_json = candidate_json.clone();
    backup_json["offer_id"] = json!("pool_offer_backup_v1");
    backup_json["endpoint"] = json!("stratum+tcp://backup.example:3333/");
    let candidate = serde_json::from_value::<PoolOffer>(candidate_json)?;
    let backup = serde_json::from_value::<PoolOffer>(backup_json)?;
    let signed_candidate = adapter
        .sign_pool_offer_set_for_simulation(
            &challenge_id,
            vec![candidate.clone(), backup.clone()],
            false,
        )
        .await?;
    let signed_reordered = adapter
        .sign_pool_offer_set_for_simulation(&challenge_id, vec![backup, candidate], false)
        .await?;
    let replacement = WorkSessionId::try_from("session_failover_replacement_01".to_owned())?;

    // Act
    let decision = adapter
        .replace_pool_offer(&predecessor, replacement.clone(), &signed_candidate)
        .await?;
    let replayed = adapter
        .replace_pool_offer(&predecessor, replacement.clone(), &signed_reordered)
        .await?;
    let lease = adapter
        .start_lease(
            &replacement,
            WorkerClock::new("boot_failover_replacement_01", 0)?,
        )
        .await?;
    server.stop();
    let restarted =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let recovered = restarted
        .simulated_pool_adapter()
        .replace_pool_offer(&predecessor, replacement.clone(), &signed_candidate)
        .await?;

    // Assert
    assert_eq!(decision.status(), PoolOfferReplacementStatus::Equivalent);
    assert_eq!(decision.maybe_replacement_session_id(), Some(&replacement));
    assert_eq!(replayed, decision);
    assert_eq!(recovered, decision);
    assert!(!lease.lease_id().is_empty());
    Ok(())
}

#[tokio::test]
async fn concurrent_material_candidates_converge_on_one_pending_reconfirmation()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let adapter = application.simulated_pool_adapter();
    let server = RunningServer::spawn(bwg_core::authority::router(application)).await?;
    let challenge = issue_challenge(&server.base_url, "action_material_failover_01").await?;
    let challenge_id = ChallengeId::try_from(
        challenge["challenge_id"]
            .as_str()
            .ok_or("challenge response needs an identifier")?
            .to_owned(),
    )?;
    adapter
        .consent_default_pool_offer_for_simulation(&challenge_id)
        .await?;
    let predecessor = WorkSessionId::try_from("session_material_predecessor_01".to_owned())?;
    adapter
        .register_session(&challenge_id, predecessor.clone())
        .await?;
    adapter.fail_session(&predecessor).await?;
    let original = challenge["pool_offers"]["offers"][0].clone();
    let mut economic_json = original.clone();
    economic_json["reward_policy"]["selected_destination_basis_points"] = json!(9_900);
    economic_json["reward_policy"]["pool_fee_basis_points"] = json!(100);
    let mut privacy_json = original;
    privacy_json["privacy_terms_url"] = json!("https://authority.example/privacy-v2");
    let economic = serde_json::from_value::<PoolOffer>(economic_json)?;
    let privacy = serde_json::from_value::<PoolOffer>(privacy_json)?;
    let signed_economic = adapter
        .sign_pool_offer_set_for_simulation(&challenge_id, vec![economic], false)
        .await?;
    let signed_privacy = adapter
        .sign_pool_offer_set_for_simulation(&challenge_id, vec![privacy], false)
        .await?;
    let economic_session = WorkSessionId::try_from("session_material_economic_01".to_owned())?;
    let privacy_session = WorkSessionId::try_from("session_material_privacy_01".to_owned())?;

    // Act
    let (economic_result, privacy_result) = tokio::join!(
        adapter.replace_pool_offer(&predecessor, economic_session.clone(), &signed_economic,),
        adapter.replace_pool_offer(&predecessor, privacy_session.clone(), &signed_privacy,),
    );
    let (decision, winner_session, winner_signed, loser_result) =
        match (economic_result, privacy_result) {
            (Ok(decision), loser) => (decision, economic_session, signed_economic, loser),
            (loser, Ok(decision)) => (decision, privacy_session, signed_privacy, loser),
            (first, second) => {
                return Err(
                    format!("material race did not converge: {first:?}, {second:?}").into(),
                );
            }
        };
    let blocked_lease = adapter
        .start_lease(
            &winner_session,
            WorkerClock::new("boot_material_pending_01", 0)?,
        )
        .await;
    server.stop();
    let restarted =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let replayed = restarted
        .simulated_pool_adapter()
        .replace_pool_offer(&predecessor, winner_session, &winner_signed)
        .await?;

    // Assert
    assert_eq!(
        decision.status(),
        PoolOfferReplacementStatus::PendingReconfirmation
    );
    assert!(decision.maybe_replacement_session_id().is_none());
    assert_eq!(replayed, decision);
    assert!(matches!(
        loser_result,
        Err(AuthorityApplicationError::ConflictingPoolOfferReplacement)
    ));
    assert!(matches!(
        blocked_lease,
        Err(AuthorityApplicationError::UnknownWorkSession)
    ));
    assert!(matches!(
        decision.change(),
        PoolOfferChange::MateriallyChanged { changes }
            if matches!(changes.as_slice(),
                [MaterialPoolOfferChange::EconomicTerms]
                | [MaterialPoolOfferChange::PrivacyTerms])
    ));
    assert_eq!(decision.candidate_signature(), winner_signed.signature());
    Ok(())
}

#[tokio::test]
async fn every_material_category_stays_pending_without_a_work_session() -> Result<(), Box<dyn Error>>
{
    let database = PostgresTestDatabase::start().await?;
    let application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let adapter = application.simulated_pool_adapter();
    let server = RunningServer::spawn(bwg_core::authority::router(application)).await?;
    let cases: [(&str, OfferMutation); 5] = [
        ("reward", change_reward),
        ("fee", change_fee),
        ("payout", change_payout),
        ("privacy", change_privacy),
        ("operator", change_operator),
    ];

    for (suffix, change) in cases {
        let challenge =
            issue_challenge(&server.base_url, &format!("action_material_{suffix}")).await?;
        let challenge_id = ChallengeId::try_from(
            challenge["challenge_id"]
                .as_str()
                .ok_or("challenge ID")?
                .to_owned(),
        )?;
        adapter
            .consent_default_pool_offer_for_simulation(&challenge_id)
            .await?;
        let predecessor = WorkSessionId::try_from(format!("session_material_{suffix}_old"))?;
        adapter
            .register_session(&challenge_id, predecessor.clone())
            .await?;
        adapter.fail_session(&predecessor).await?;
        let mut candidate = challenge["pool_offers"]["offers"][0].clone();
        change(&mut candidate);
        let signed = adapter
            .sign_pool_offer_set_for_simulation(
                &challenge_id,
                vec![serde_json::from_value(candidate)?],
                false,
            )
            .await?;
        let proposed = WorkSessionId::try_from(format!("session_material_{suffix}_new"))?;

        let decision = adapter
            .replace_pool_offer(&predecessor, proposed.clone(), &signed)
            .await?;
        let lease = adapter
            .start_lease(
                &proposed,
                WorkerClock::new(format!("boot_material_{suffix}"), 0)?,
            )
            .await;

        assert_eq!(
            decision.status(),
            PoolOfferReplacementStatus::PendingReconfirmation
        );
        assert!(decision.maybe_replacement_session_id().is_none());
        assert!(matches!(
            lease,
            Err(AuthorityApplicationError::UnknownWorkSession)
        ));
    }
    server.stop();
    Ok(())
}

fn change_reward(value: &mut Value) {
    value["reward_policy"]["selected_destination_basis_points"] = json!(9_900);
    value["reward_policy"]["pool_fee_basis_points"] = json!(100);
}

fn change_fee(value: &mut Value) {
    value["reward_policy"]["selected_destination_basis_points"] = json!(9_900);
    value["reward_policy"]["service_fee_basis_points"] = json!(100);
}

fn change_payout(value: &mut Value) {
    value["payout_requirements"]["approved_beneficiaries"] = json!([{
        "beneficiary_id": "research", "display_name": "Research",
        "terms_url": "https://authority.example/research-terms"
    }]);
}

fn change_privacy(value: &mut Value) {
    value["privacy_terms_url"] = json!("https://authority.example/privacy-v2");
}

fn change_operator(value: &mut Value) {
    value["operator_terms_url"] = json!("https://authority.example/terms-v2");
}

#[tokio::test]
async fn stale_predecessor_generation_cannot_persist_an_equivalent_decision()
-> Result<(), Box<dyn Error>> {
    let database = PostgresTestDatabase::start().await?;
    let application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let adapter = application.simulated_pool_adapter();
    let server = RunningServer::spawn(bwg_core::authority::router(application)).await?;
    let challenge = issue_challenge(&server.base_url, "action_stale_failover_01").await?;
    let challenge_id = ChallengeId::try_from(
        challenge["challenge_id"]
            .as_str()
            .ok_or("challenge ID")?
            .to_owned(),
    )?;
    adapter
        .consent_default_pool_offer_for_simulation(&challenge_id)
        .await?;
    let predecessor = WorkSessionId::try_from("session_stale_predecessor_01".to_owned())?;
    adapter
        .register_session(&challenge_id, predecessor.clone())
        .await?;
    adapter.fail_session(&predecessor).await?;
    let existing = WorkSessionId::try_from("session_stale_existing_01".to_owned())?;
    adapter
        .replace_session(&predecessor, existing.clone())
        .await?;
    let candidate =
        serde_json::from_value::<PoolOffer>(challenge["pool_offers"]["offers"][0].clone())?;
    let signed = adapter
        .sign_pool_offer_set_for_simulation(&challenge_id, vec![candidate], false)
        .await?;

    let result = adapter
        .replace_pool_offer(
            &predecessor,
            WorkSessionId::try_from("session_stale_candidate_01".to_owned())?,
            &signed,
        )
        .await;
    let retained = adapter.maybe_session_replacement(&existing).await?;

    assert!(matches!(
        result,
        Err(AuthorityApplicationError::ConflictingWorkSessionReplacement)
    ));
    assert!(retained.is_some());
    server.stop();
    Ok(())
}

async fn issue_challenge(
    authority_url: &str,
    action_reference: &str,
) -> Result<Value, Box<dyn Error>> {
    Ok(reqwest::Client::new()
        .post(format!("{authority_url}/v0/challenges"))
        .header(CLIENT_ID_HEADER, CLIENT_ID)
        .bearer_auth(SERVICE_SECRET)
        .json(&json!({
            "action_policy": "account-creation.light.v1",
            "action_reference": action_reference,
            "claimant_key": CLAIMANT_PUBLIC_JWK,
        }))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?)
}

fn authority_config() -> Result<Config, Box<dyn Error>> {
    let credential = ServiceCredential::new(
        CLIENT_ID,
        SERVICE_SECRET,
        DeploymentEnvironment::Development,
        "https://relying.example".to_owned(),
        vec!["https://app.relying.example".to_owned()],
        vec![ActionPolicy::AccountCreationLightV1],
    )?;
    let public = AuthorityPublicConfig::new(
        "https://authority.example",
        "https://authority.example",
        authority_keys()?,
        "https://authority.example/policies/operator",
        "https://authority.example/privacy",
        "https://authority.example/terms",
    )?;
    Ok(
        Config::new(DeploymentEnvironment::Development, vec![credential], public)?
            .with_signing_key_seed("authority-a".to_owned(), AUTHORITY_SIGNING_SEED)?,
    )
}
