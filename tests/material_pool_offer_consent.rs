use std::{error::Error, sync::Arc};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use bwg_core::{
    authority::{self, AuthorityApplication, AuthorityApplicationError},
    challenge::{ActionPolicy, ChallengeId},
    lifecycle::WorkerClock,
    pool_offer::{PoolOffer, PoolOfferReplacementStatus},
    progress::WorkSessionId,
};
use ring::digest;
use serde_json::{Value, json};

#[path = "support/authority_keys.rs"]
mod authority_key_support;
#[path = "support/postgres.rs"]
mod postgres_support;
#[path = "support/running_server.rs"]
mod running_server_support;
#[path = "support/trusted_consent_authority.rs"]
mod trusted_consent_authority_support;
#[path = "support/trusted_consent_verifier.rs"]
mod trusted_consent_verifier_support;

use postgres_support::PostgresTestDatabase;
use running_server_support::RunningServer;
use trusted_consent_authority_support::{
    authority_config, authority_config_without_signer, issue_challenge,
};
use trusted_consent_verifier_support::FakeVerifier;

#[tokio::test]
async fn candidate_identity_race_converges_across_different_challenges()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let application = AuthorityApplication::connect_postgres_with_trusted_consent_verifier(
        authority_config()?,
        database.database_url(),
        Arc::new(FakeVerifier::default()),
    )
    .await?;
    let adapter = application.simulated_pool_adapter();
    let server = RunningServer::spawn(authority::router(application)).await?;
    let material_challenge = issue_challenge(
        &server.base_url,
        ActionPolicy::ACCOUNT_CREATION_STANDARD_V1,
        "action_material_cross_challenge_01",
    )
    .await?;
    let registration_challenge = issue_challenge(
        &server.base_url,
        ActionPolicy::ACCOUNT_CREATION_STANDARD_V1,
        "action_registration_cross_challenge_01",
    )
    .await?;
    let material_challenge_id = challenge_id(&material_challenge)?;
    let registration_challenge_id = challenge_id(&registration_challenge)?;
    for challenge_id in [&material_challenge_id, &registration_challenge_id] {
        adapter
            .consent_default_pool_offer_for_simulation(challenge_id)
            .await?;
    }
    let predecessor = WorkSessionId::try_from("session_cross_challenge_predecessor_01".to_owned())?;
    adapter
        .register_session(&material_challenge_id, predecessor.clone())
        .await?;
    adapter.fail_session(&predecessor).await?;
    let mut candidate_json = material_challenge["pool_offers"]["offers"][0].clone();
    candidate_json["privacy_terms_url"] = json!("https://authority.example/privacy-v2");
    let signed_candidate = adapter
        .sign_pool_offer_set_for_simulation(
            &material_challenge_id,
            vec![serde_json::from_value(candidate_json)?],
            false,
        )
        .await?;
    let candidate_session =
        WorkSessionId::try_from("session_cross_challenge_candidate_01".to_owned())?;

    // Act
    let (decision, registration) = tokio::join!(
        adapter.replace_pool_offer(&predecessor, candidate_session.clone(), &signed_candidate,),
        adapter.register_session(&registration_challenge_id, candidate_session.clone()),
    );

    // Assert
    match (decision, registration) {
        (Ok(decision), Err(AuthorityApplicationError::TrustedConsentRequired)) => {
            assert_eq!(
                decision.status(),
                PoolOfferReplacementStatus::PendingReconfirmation
            );
            assert!(matches!(
                adapter.session_lifecycle(&candidate_session).await,
                Err(AuthorityApplicationError::UnknownWorkSession)
            ));
        }
        (Err(AuthorityApplicationError::ConflictingWorkSessionReplacement), Ok(())) => {
            assert_eq!(
                adapter
                    .session_lifecycle(&candidate_session)
                    .await?
                    .challenge_id(),
                &registration_challenge_id
            );
            assert!(matches!(
                adapter.pool_failover_projection(&predecessor).await,
                Err(AuthorityApplicationError::UnknownPoolOfferReplacement)
            ));
        }
        (decision, registration) => {
            return Err(format!(
                "candidate identity race did not converge safely: {decision:?}, {registration:?}"
            )
            .into());
        }
    }
    server.stop();
    Ok(())
}

#[tokio::test]
async fn pending_material_candidate_reserves_its_session_identity_until_confirmation()
-> Result<(), Box<dyn Error>> {
    // Arrange
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
        "action_material_reserved_session_01",
    )
    .await?;
    let challenge_id = ChallengeId::try_from(
        challenge["challenge_id"]
            .as_str()
            .ok_or("challenge ID")?
            .to_owned(),
    )?;
    adapter
        .consent_default_pool_offer_for_simulation(&challenge_id)
        .await?;
    let predecessor = WorkSessionId::try_from("session_material_reserved_old_01".to_owned())?;
    adapter
        .register_session(&challenge_id, predecessor.clone())
        .await?;
    adapter.fail_session(&predecessor).await?;
    let mut candidate_json = challenge["pool_offers"]["offers"][0].clone();
    candidate_json["privacy_terms_url"] = json!("https://authority.example/privacy-v2");
    let signed_candidate = adapter
        .sign_pool_offer_set_for_simulation(
            &challenge_id,
            vec![serde_json::from_value(candidate_json)?],
            false,
        )
        .await?;
    let candidate_session = WorkSessionId::try_from("session_material_reserved_new_01".to_owned())?;
    adapter
        .replace_pool_offer(&predecessor, candidate_session.clone(), &signed_candidate)
        .await?;

    // Act
    let result = adapter
        .register_session(&challenge_id, candidate_session.clone())
        .await;
    let lease = adapter
        .start_lease(
            &candidate_session,
            WorkerClock::new("boot_material_reserved_01", 0)?,
        )
        .await;

    // Assert
    assert!(matches!(
        result,
        Err(AuthorityApplicationError::TrustedConsentRequired)
    ));
    assert!(matches!(
        lease,
        Err(AuthorityApplicationError::UnknownWorkSession)
    ));
    server.stop();
    Ok(())
}

#[tokio::test]
async fn material_candidate_requires_its_fresh_receipt_before_replacement_lease()
-> Result<(), Box<dyn Error>> {
    // Arrange
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
        "action_material_consent_01",
    )
    .await?;
    let challenge_id = ChallengeId::try_from(
        challenge["challenge_id"]
            .as_str()
            .ok_or("challenge ID")?
            .to_owned(),
    )?;
    adapter
        .consent_default_pool_offer_for_simulation(&challenge_id)
        .await?;
    let predecessor = WorkSessionId::try_from("session_material_consent_old_01".to_owned())?;
    adapter
        .register_session(&challenge_id, predecessor.clone())
        .await?;
    adapter.fail_session(&predecessor).await?;
    let mut candidate_json = challenge["pool_offers"]["offers"][0].clone();
    candidate_json["reward_policy"]["selected_destination_basis_points"] = json!(9_900);
    candidate_json["reward_policy"]["pool_fee_basis_points"] = json!(100);
    let candidate = serde_json::from_value::<PoolOffer>(candidate_json)?;
    let signed_candidate = adapter
        .sign_pool_offer_set_for_simulation(&challenge_id, vec![candidate], false)
        .await?;
    let candidate_session = WorkSessionId::try_from("session_material_consent_new_01".to_owned())?;
    let pending = adapter
        .replace_pool_offer(&predecessor, candidate_session.clone(), &signed_candidate)
        .await?;
    let confirmation = adapter
        .prepare_material_pool_offer_confirmation(&predecessor)
        .await?;
    let recovery_application =
        AuthorityApplication::connect_postgres_with_trusted_consent_verifier(
            authority_config_without_signer()?,
            database.database_url(),
            Arc::new(FakeVerifier::default()),
        )
        .await?;
    let recovered_confirmation = recovery_application
        .simulated_pool_adapter()
        .prepare_material_pool_offer_confirmation(&predecessor)
        .await?;
    let signature_digest = URL_SAFE_NO_PAD.encode(digest::digest(
        &digest::SHA256,
        confirmation.signed_pool_offers().signature().as_bytes(),
    ));
    let surface = reqwest::get(format!(
        "{}/v0/challenges/{}/trusted-consent?pool_offer_set_signature_sha256={}",
        server.base_url,
        challenge_id.as_str(),
        signature_digest,
    ))
    .await?
    .error_for_status()?
    .json::<Value>()
    .await?;
    let blocked = adapter
        .start_lease(
            &candidate_session,
            WorkerClock::new("boot_material_consent_01", 0)?,
        )
        .await;
    let bypass = adapter
        .replace_session(&predecessor, candidate_session.clone())
        .await;
    let wrong_receipt = adapter
        .start_material_replacement_lease(
            &predecessor,
            WorkerClock::new("boot_material_wrong_01", 0)?,
            "not-a-receipt",
        )
        .await;

    // Act
    let (begin, receipt) =
        complete_material_ceremony(&server.base_url, &challenge_id, &signature_digest).await?;
    let lease = adapter
        .start_material_replacement_lease(
            &predecessor,
            WorkerClock::new("boot_material_consent_01", 0)?,
            &receipt,
        )
        .await?;

    // Assert
    assert_eq!(
        pending.status(),
        PoolOfferReplacementStatus::PendingReconfirmation
    );
    assert_eq!(recovered_confirmation, confirmation);
    assert!(matches!(
        blocked,
        Err(AuthorityApplicationError::UnknownWorkSession)
    ));
    assert!(matches!(
        bypass,
        Err(AuthorityApplicationError::TrustedConsentRequired)
    ));
    assert!(matches!(
        wrong_receipt,
        Err(AuthorityApplicationError::InvalidTrustedConsentReceipt)
    ));
    assert_eq!(
        begin["authority_disclosure_digest_sha256"],
        confirmation.disclosure_digest_sha256()
    );
    assert_eq!(
        surface["material_confirmation"]["disclosure_digest_sha256"],
        confirmation.disclosure_digest_sha256()
    );
    assert!(!lease.lease_id().is_empty());
    server.stop();
    Ok(())
}

#[tokio::test]
async fn receipt_for_different_material_terms_cannot_release_pending_session()
-> Result<(), Box<dyn Error>> {
    // Arrange
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
        "action_material_wrong_receipt_01",
    )
    .await?;
    let challenge_id = ChallengeId::try_from(
        challenge["challenge_id"]
            .as_str()
            .ok_or("challenge ID")?
            .to_owned(),
    )?;
    adapter
        .consent_default_pool_offer_for_simulation(&challenge_id)
        .await?;
    let first_predecessor = WorkSessionId::try_from("session_material_first_old_01".to_owned())?;
    let second_predecessor = WorkSessionId::try_from("session_material_second_old_01".to_owned())?;
    for predecessor in [&first_predecessor, &second_predecessor] {
        adapter
            .register_session(&challenge_id, predecessor.clone())
            .await?;
        adapter.fail_session(predecessor).await?;
    }
    let original = challenge["pool_offers"]["offers"][0].clone();
    let mut first_json = original.clone();
    first_json["reward_policy"]["selected_destination_basis_points"] = json!(9_900);
    first_json["reward_policy"]["pool_fee_basis_points"] = json!(100);
    let mut second_json = original;
    second_json["privacy_terms_url"] = json!("https://authority.example/privacy-v2");
    let first_signed = adapter
        .sign_pool_offer_set_for_simulation(
            &challenge_id,
            vec![serde_json::from_value(first_json)?],
            false,
        )
        .await?;
    let second_signed = adapter
        .sign_pool_offer_set_for_simulation(
            &challenge_id,
            vec![serde_json::from_value(second_json)?],
            false,
        )
        .await?;
    let first_session = WorkSessionId::try_from("session_material_first_new_01".to_owned())?;
    let second_session = WorkSessionId::try_from("session_material_second_new_01".to_owned())?;
    adapter
        .replace_pool_offer(&first_predecessor, first_session.clone(), &first_signed)
        .await?;
    adapter
        .replace_pool_offer(&second_predecessor, second_session, &second_signed)
        .await?;
    let second_confirmation = adapter
        .prepare_material_pool_offer_confirmation(&second_predecessor)
        .await?;
    let second_digest = URL_SAFE_NO_PAD.encode(digest::digest(
        &digest::SHA256,
        second_confirmation
            .signed_pool_offers()
            .signature()
            .as_bytes(),
    ));
    let (_, wrong_receipt) =
        complete_material_ceremony(&server.base_url, &challenge_id, &second_digest).await?;

    // Act
    let result = adapter
        .start_material_replacement_lease(
            &first_predecessor,
            WorkerClock::new("boot_material_wrong_terms_01", 0)?,
            &wrong_receipt,
        )
        .await;
    let unreleased = adapter
        .start_lease(
            &first_session,
            WorkerClock::new("boot_material_unreleased_01", 0)?,
        )
        .await;

    // Assert
    assert!(matches!(
        result,
        Err(AuthorityApplicationError::InvalidTrustedConsentReceipt)
    ));
    assert!(matches!(
        unreleased,
        Err(AuthorityApplicationError::UnknownWorkSession)
    ));
    server.stop();
    Ok(())
}

async fn complete_material_ceremony(
    authority_url: &str,
    challenge_id: &ChallengeId,
    signature_digest: &str,
) -> Result<(Value, String), Box<dyn Error>> {
    let begin = reqwest::Client::new()
        .post(format!(
            "{authority_url}/v0/challenges/{}/trusted-consent",
            challenge_id.as_str(),
        ))
        .json(&json!({
            "pool_offer_set_signature_sha256": signature_digest,
            "reason": "material_pool_terms",
            "authority_origin": "https://authority.example"
        }))
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    let ceremony_id = begin["ceremony_id"].as_str().ok_or("ceremony ID")?;
    let finish = reqwest::Client::new()
        .post(format!(
            "{authority_url}/v0/challenges/{}/trusted-consent/{ceremony_id}",
            challenge_id.as_str(),
        ))
        .json(&json!({ "credential": "valid" }))
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    let receipt = finish["trusted_consent_receipt"]
        .as_str()
        .ok_or("receipt")?
        .to_owned();
    Ok((begin, receipt))
}

fn challenge_id(challenge: &Value) -> Result<ChallengeId, Box<dyn Error>> {
    Ok(ChallengeId::try_from(
        challenge["challenge_id"]
            .as_str()
            .ok_or("challenge ID")?
            .to_owned(),
    )?)
}
