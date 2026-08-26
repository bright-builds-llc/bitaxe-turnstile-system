use std::error::Error;

use axum::Router;
use bwg_core::{
    authority::{
        self, AuthorityApplication, AuthorityApplicationError, AuthorityPublicConfig,
        CLIENT_ID_HEADER, Config, DeploymentEnvironment, ServiceCredential,
    },
    challenge::{ActionPolicy, ChallengeId},
    crypto_profile::AuthorityKeySet,
    pool_offer::{
        MaterialPoolOfferChange, PoolOffer, PoolOfferChange, PoolOfferError, PoolSelection,
        SignedPoolOfferSet, classify_pool_offer_change, verify_pool_offer_set,
    },
    progress::WorkSessionId,
};
use serde_json::{Value, json};
use tokio::net::TcpListener;

#[path = "support/authority_keys.rs"]
mod authority_key_support;
#[path = "support/postgres.rs"]
mod postgres_support;
use authority_key_support::{CLAIMANT_PUBLIC_JWK, authority_keys};
use postgres_support::PostgresTestDatabase;

const CLIENT_ID: &str = "pool-offer-reference-service";
const SERVICE_SECRET: &str = "pool-offer-secret-P9vK2mQ7xR4tY8uN3cF6wL1zA5dH0sJ";
const AUTHORITY_SIGNING_SEED: &str = "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A";

#[tokio::test]
async fn challenge_discloses_one_authority_signed_solo_direct_payout_offer()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let authority_url = spawn_http(authority::router(application)).await?;

    // Act
    let response = reqwest::Client::new()
        .post(format!("{authority_url}/v0/challenges"))
        .header(CLIENT_ID_HEADER, CLIENT_ID)
        .bearer_auth(SERVICE_SECRET)
        .json(&json!({
            "action_policy": "account-creation.light.v1",
            "action_reference": "action_pool_offer_01",
            "claimant_key": CLAIMANT_PUBLIC_JWK
        }))
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(format!("challenge issuance failed: {}", response.text().await?).into());
    }
    let challenge = response.json::<Value>().await?;
    let signed_offers =
        serde_json::from_value::<SignedPoolOfferSet>(challenge["pool_offers"].clone())?;
    let challenge_id = challenge["challenge_id"]
        .as_str()
        .ok_or("challenge needs an identifier")?;
    let keys = AuthorityKeySet::try_from(authority_keys()?)?;
    let verified = verify_pool_offer_set(
        &signed_offers,
        "https://authority.example",
        challenge_id,
        ActionPolicy::AccountCreationLightV1,
        keys.keys(),
    )?;

    // Assert
    assert_eq!(verified.action_policy(), "account-creation.light.v1");
    assert_eq!(verified.challenge_id(), challenge_id);
    assert_eq!(verified.offers().len(), 1);
    let offer = &verified.offers()[0];
    assert_eq!(offer.offer_id(), "pool_offer_hydra_solo_v1");
    assert_eq!(offer.mining_transport(), "stratum_v1");
    assert_eq!(offer.reward_policy().mode(), "solo_direct_coinbase");
    assert_eq!(offer.reward_policy().pool_fee_basis_points(), 0);
    assert_eq!(offer.reward_policy().service_fee_basis_points(), 0);
    assert!(!offer.reward_policy().accepted_work_creates_revenue_claim());
    assert!(!offer.reward_policy().creates_custodial_balance());
    assert!(offer.payout_requirements().selection_required());
    assert!(offer.payout_requirements().ephemeral_by_default());
    assert_eq!(
        offer.mining_pool().version(),
        "v0.12.0+8eca024bde6c2de74620dce2f9cc7fb9a544c5c0"
    );
    assert_eq!(
        offer.mining_pool().source_url(),
        "https://github.com/p2poolv2/p2poolv2/tree/8eca024bde6c2de74620dce2f9cc7fb9a544c5c0"
    );
    assert_eq!(offer.mining_pool().license(), "AGPL-3.0-or-later");
    assert_eq!(offer.pool_adapter().license(), "MIT");
    assert!(offer.privacy_terms_url().starts_with("https://"));
    assert!(offer.operator_terms_url().starts_with("https://"));

    Ok(())
}

#[tokio::test]
async fn browser_pool_offer_substitution_breaks_the_authority_signature()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let authority_url = spawn_http(authority::router(application)).await?;
    let challenge = issue_challenge(&authority_url, "action_pool_tamper_01").await?;
    let mut tampered = challenge["pool_offers"].clone();
    tampered["offers"][0]["endpoint"] = json!("stratum+tcp://attacker.example:3333/");
    let tampered = serde_json::from_value::<SignedPoolOfferSet>(tampered)?;
    let keys = AuthorityKeySet::try_from(authority_keys()?)?;
    let challenge_id = challenge["challenge_id"]
        .as_str()
        .ok_or("challenge needs an identifier")?;

    // Act
    let result = verify_pool_offer_set(
        &tampered,
        "https://authority.example",
        challenge_id,
        ActionPolicy::AccountCreationLightV1,
        keys.keys(),
    );
    let wrong_policy = verify_pool_offer_set(
        &serde_json::from_value::<SignedPoolOfferSet>(challenge["pool_offers"].clone())?,
        "https://authority.example",
        challenge_id,
        ActionPolicy::AccountCreationStandardV1,
        keys.keys(),
    );
    let wrong_challenge = verify_pool_offer_set(
        &serde_json::from_value::<SignedPoolOfferSet>(challenge["pool_offers"].clone())?,
        "https://authority.example",
        "challenge_other_signed_context",
        ActionPolicy::AccountCreationLightV1,
        keys.keys(),
    );

    // Assert
    assert!(matches!(result, Err(PoolOfferError::SignedOfferMismatch)));
    assert!(matches!(
        wrong_policy,
        Err(PoolOfferError::SignedOfferContextMismatch)
    ));
    assert!(matches!(
        wrong_challenge,
        Err(PoolOfferError::SignedOfferContextMismatch)
    ));

    Ok(())
}

#[tokio::test]
async fn offer_equivalence_ignores_endpoint_but_detects_changed_economics()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let authority_url = spawn_http(authority::router(application)).await?;
    let challenge = issue_challenge(&authority_url, "action_pool_equivalence_01").await?;
    let original = challenge["pool_offers"]["offers"][0].clone();
    let mut equivalent = original.clone();
    equivalent["endpoint"] = json!("stratum+tcp://failover.example:3333/");
    let mut changed = equivalent.clone();
    changed["reward_policy"]["selected_destination_basis_points"] = json!(9_900);
    changed["reward_policy"]["pool_fee_basis_points"] = json!(100);
    let original = serde_json::from_value::<PoolOffer>(original)?;
    let equivalent = serde_json::from_value::<PoolOffer>(equivalent)?;
    let changed = serde_json::from_value::<PoolOffer>(changed)?;

    // Act
    let equivalent_result = classify_pool_offer_change(&original, &equivalent)?;
    let changed_result = classify_pool_offer_change(&original, &changed)?;

    // Assert
    assert_eq!(equivalent_result, PoolOfferChange::Equivalent);
    assert!(matches!(
        changed_result,
        PoolOfferChange::MateriallyChanged { ref changes }
            if changes.as_slice() == [MaterialPoolOfferChange::EconomicTerms]
    ));

    Ok(())
}

#[tokio::test]
async fn authority_without_an_offer_terms_signer_fails_challenge_issuance_closed()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let application = AuthorityApplication::connect_postgres(
        authority_config_without_signer()?,
        database.database_url(),
    )
    .await?;
    let authority_url = spawn_http(authority::router(application)).await?;

    // Act
    let response = reqwest::Client::new()
        .post(format!("{authority_url}/v0/challenges"))
        .header(CLIENT_ID_HEADER, CLIENT_ID)
        .bearer_auth(SERVICE_SECRET)
        .json(&json!({
            "action_policy": "account-creation.light.v1",
            "action_reference": "action_unsigned_pool_offer_01",
            "claimant_key": CLAIMANT_PUBLIC_JWK
        }))
        .send()
        .await?;

    // Assert
    assert_eq!(response.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        response.json::<Value>().await?,
        json!({ "error": "pool_offer_signing_unavailable" })
    );

    Ok(())
}

#[tokio::test]
async fn payout_selection_can_change_before_consent_but_is_locked_before_work()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let adapter = application.simulated_pool_adapter();
    let authority_url = spawn_http(authority::router(application)).await?;
    let challenge = issue_challenge(&authority_url, "action_pool_selection_01").await?;
    let challenge_id = ChallengeId::try_from(
        challenge["challenge_id"]
            .as_str()
            .ok_or("challenge needs an identifier")?
            .to_owned(),
    )?;
    let session_id = WorkSessionId::try_from("session_pool_selection_01".to_owned())?;
    let missing_selection = adapter
        .register_session(&challenge_id, session_id.clone())
        .await;
    let invalid_checksum = PoolSelection::bitcoin_address(
        "pool_offer_hydra_solo_v1".to_owned(),
        "1BoatSLRHtKNngkdXEeobR76b53LETtpyU".to_owned(),
    );
    let unapproved_selection = PoolSelection::bitcoin_address(
        "pool_offer_attacker".to_owned(),
        "1BoatSLRHtKNngkdXEeobR76b53LETtpyT".to_owned(),
    )?;
    let unapproved = adapter
        .propose_pool_selection(&challenge_id, &unapproved_selection)
        .await;
    let first_selection = PoolSelection::bitcoin_address(
        "pool_offer_hydra_solo_v1".to_owned(),
        "1BoatSLRHtKNngkdXEeobR76b53LETtpyT".to_owned(),
    )?;
    let first = adapter
        .propose_pool_selection(&challenge_id, &first_selection)
        .await?;
    let selected_address = "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy".to_owned();

    // Act
    let second_selection = PoolSelection::bitcoin_address(
        "pool_offer_hydra_solo_v1".to_owned(),
        selected_address.clone(),
    )?;
    assert_eq!(second_selection.payout_destination(), selected_address);
    let second = adapter
        .propose_pool_selection(&challenge_id, &second_selection)
        .await?;
    let wrong_commitment = adapter
        .confirm_pool_selection(&challenge_id, &"0".repeat(64))
        .await;
    adapter
        .confirm_pool_selection(&challenge_id, second.commitment())
        .await?;
    adapter
        .confirm_pool_selection(&challenge_id, second.commitment())
        .await?;
    let changed_selection = PoolSelection::bitcoin_address(
        "pool_offer_hydra_solo_v1".to_owned(),
        "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu".to_owned(),
    )?;
    let changed_after_consent = adapter
        .propose_pool_selection(&challenge_id, &changed_selection)
        .await;
    adapter.register_session(&challenge_id, session_id).await?;

    // Assert
    assert!(matches!(
        missing_selection,
        Err(AuthorityApplicationError::PoolSelectionRequired)
    ));
    assert!(matches!(
        invalid_checksum,
        Err(PoolOfferError::InvalidPayoutSelection)
    ));
    assert!(matches!(
        unapproved,
        Err(AuthorityApplicationError::UnknownPoolOffer)
    ));
    assert_ne!(first.commitment(), second.commitment());
    assert_eq!(second.commitment().len(), 64);
    assert!(!second.commitment().contains(&selected_address));
    assert!(matches!(
        wrong_commitment,
        Err(AuthorityApplicationError::PoolSelectionMismatch)
    ));
    assert!(matches!(
        changed_after_consent,
        Err(AuthorityApplicationError::PoolSelectionLocked)
    ));
    assert!(!challenge.to_string().contains(&selected_address));

    Ok(())
}

#[tokio::test]
async fn consented_pool_selection_remains_locked_after_authority_restart()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let first_application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let first_adapter = first_application.simulated_pool_adapter();
    let authority_url = spawn_http(authority::router(first_application)).await?;
    let challenge = issue_challenge(&authority_url, "action_pool_restart_01").await?;
    let challenge_id = ChallengeId::try_from(
        challenge["challenge_id"]
            .as_str()
            .ok_or("challenge needs an identifier")?
            .to_owned(),
    )?;
    let selection = PoolSelection::bitcoin_address(
        "pool_offer_hydra_solo_v1".to_owned(),
        "1BoatSLRHtKNngkdXEeobR76b53LETtpyT".to_owned(),
    )?;
    let proposed = first_adapter
        .propose_pool_selection(&challenge_id, &selection)
        .await?;
    first_adapter
        .confirm_pool_selection(&challenge_id, proposed.commitment())
        .await?;
    let restarted =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let restarted_adapter = restarted.simulated_pool_adapter();
    let changed = PoolSelection::bitcoin_address(
        "pool_offer_hydra_solo_v1".to_owned(),
        "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy".to_owned(),
    )?;

    // Act
    let changed = restarted_adapter
        .propose_pool_selection(&challenge_id, &changed)
        .await;
    let session = restarted_adapter
        .register_session(
            &challenge_id,
            WorkSessionId::try_from("session_pool_restart_01".to_owned())?,
        )
        .await;

    // Assert
    assert!(matches!(
        changed,
        Err(AuthorityApplicationError::PoolSelectionLocked)
    ));
    assert!(session.is_ok());

    Ok(())
}

#[tokio::test]
async fn pool_facing_authorization_requires_the_authority_retained_session_selection()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let adapter = application.simulated_pool_adapter();
    let authority_url = spawn_http(authority::router(application)).await?;
    let challenge = issue_challenge(&authority_url, "action_pool_authorization_01").await?;
    let challenge_id = ChallengeId::try_from(
        challenge["challenge_id"]
            .as_str()
            .ok_or("challenge needs an identifier")?
            .to_owned(),
    )?;
    let session_id = WorkSessionId::try_from("session_pool_authorization_01".to_owned())?;
    let retained_selection = PoolSelection::bitcoin_address(
        "pool_offer_hydra_solo_v1".to_owned(),
        "1BoatSLRHtKNngkdXEeobR76b53LETtpyT".to_owned(),
    )?;
    adapter
        .consent_pool_selection_for_simulation(&challenge_id, &retained_selection)
        .await?;
    adapter
        .register_session(&challenge_id, session_id.clone())
        .await?;
    let substituted_selection = PoolSelection::bitcoin_address(
        "pool_offer_hydra_solo_v1".to_owned(),
        "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy".to_owned(),
    )?;

    // Act
    let authorized = adapter
        .upstream_authorization_for_simulation(&session_id, &retained_selection, "x".to_owned())
        .await?;
    let substituted = adapter
        .upstream_authorization_for_simulation(&session_id, &substituted_selection, "x".to_owned())
        .await;
    let unknown_session = adapter
        .upstream_authorization_for_simulation(
            &WorkSessionId::try_from("session_pool_authorization_unknown".to_owned())?,
            &retained_selection,
            "x".to_owned(),
        )
        .await;

    // Assert
    assert_eq!(authorized.payout_commitment().len(), 64);
    assert!(matches!(
        substituted,
        Err(AuthorityApplicationError::InvalidUpstreamAuthorization)
    ));
    assert!(matches!(
        unknown_session,
        Err(AuthorityApplicationError::UnknownWorkSession)
    ));
    Ok(())
}

async fn issue_challenge(
    authority_url: &str,
    action_reference: &str,
) -> Result<Value, Box<dyn Error>> {
    let response = reqwest::Client::new()
        .post(format!("{authority_url}/v0/challenges"))
        .header(CLIENT_ID_HEADER, CLIENT_ID)
        .bearer_auth(SERVICE_SECRET)
        .json(&json!({
            "action_policy": "account-creation.light.v1",
            "action_reference": action_reference,
            "claimant_key": CLAIMANT_PUBLIC_JWK
        }))
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(format!("challenge issuance failed: {}", response.text().await?).into());
    }
    Ok(response.json().await?)
}

fn authority_config() -> Result<Config, Box<dyn Error>> {
    Ok(authority_config_without_signer()?
        .with_signing_key_seed("authority-a".to_owned(), AUTHORITY_SIGNING_SEED)?)
}

fn authority_config_without_signer() -> Result<Config, Box<dyn Error>> {
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
    Ok(Config::new(
        DeploymentEnvironment::Development,
        vec![credential],
        public,
    )?)
}

async fn spawn_http(router: Router) -> Result<String, std::io::Error> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("test server should run until its task is dropped");
    });
    Ok(format!("http://{address}"))
}
