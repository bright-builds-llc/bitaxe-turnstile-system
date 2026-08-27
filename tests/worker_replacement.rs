use std::{
    error::Error,
    time::{SystemTime, UNIX_EPOCH},
};

use bwg_core::{
    authority::{
        AuthorityApplication, AuthorityApplicationError, AuthorityPublicConfig, CLIENT_ID_HEADER,
        Config, DeploymentEnvironment, IssuanceProcessingOutcome, IssuanceWorkerId,
        ServiceCredential,
    },
    challenge::{ActionPolicy, ChallengeId},
    lifecycle::{SessionLifecycleState, WorkerClock},
    progress::{ProgressError, WorkSessionId},
    stratum_v1::{
        PostgresStratumSessionRegistry, StratumCredentialIssuer, StratumV1Error,
        WorkSessionDisconnectSink,
    },
};
use serde_json::{Value, json};

#[path = "support/authority_keys.rs"]
mod authority_key_support;
#[path = "support/postgres.rs"]
mod postgres_support;
#[path = "support/running_server.rs"]
mod running_server_support;
#[path = "support/work_session.rs"]
mod work_session_support;

use authority_key_support::{CLAIMANT_PUBLIC_JWK, authority_keys};
use postgres_support::PostgresTestDatabase;
use running_server_support::RunningServer;
use work_session_support::{accepted_event, stratum_credentials};

const CLIENT_ID: &str = "worker-replacement-reference-service";
const SERVICE_SECRET: &str = "worker-replacement-P9vK2mQ7xR4tY8uN3cF6wL1zA5dH0sJ";
const AUTHORITY_SIGNING_SEED: &str = "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A";

#[tokio::test]
async fn threshold_completion_stops_a_ready_late_replacement() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let adapter = application.simulated_pool_adapter();
    let server = RunningServer::spawn(bwg_core::authority::router(application.clone())).await?;
    let (challenge_id, _) =
        issue_challenge(&server.base_url, "action_ready_replacement_race_01").await?;
    adapter
        .consent_default_pool_offer_for_simulation(&challenge_id)
        .await?;
    let active_session = WorkSessionId::try_from("session_active_replacement_race_01".to_owned())?;
    adapter
        .register_session(&challenge_id, active_session.clone())
        .await?;
    let active_lease = adapter
        .start_lease(
            &active_session,
            WorkerClock::new("boot_active_replacement_race_01", 0)?,
        )
        .await?;
    let ready_replacement =
        WorkSessionId::try_from("session_ready_replacement_race_01".to_owned())?;
    adapter
        .register_session(&challenge_id, ready_replacement.clone())
        .await?;
    let received_at = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();

    // Act
    let accepted = adapter
        .report(
            accepted_event(
                "event_ready_replacement_race_01",
                "share_ready_replacement_race_01",
                active_session,
                0x3f,
                received_at,
            )?,
            &active_lease,
            WorkerClock::new("boot_active_replacement_race_01", 1)?,
        )
        .await?;
    let replacement_lifecycle = adapter.session_lifecycle(&ready_replacement).await?;
    let late_start = adapter
        .start_lease(
            &ready_replacement,
            WorkerClock::new("boot_ready_replacement_race_01", 0)?,
        )
        .await;
    let issuance_worker =
        IssuanceWorkerId::try_from("worker_ready_replacement_race_01".to_owned())?;
    let issued = application
        .process_next_issuance(&issuance_worker, received_at)
        .await?;
    let pass_issued_registration = adapter
        .register_session(
            &challenge_id,
            WorkSessionId::try_from("session_pass_issued_replacement_01".to_owned())?,
        )
        .await;

    // Assert
    assert!(accepted.issuance_intent_created());
    assert_eq!(
        replacement_lifecycle.state(),
        SessionLifecycleState::Stopping
    );
    assert_eq!(
        replacement_lifecycle.maybe_stop_reason(),
        Some("challenge_satisfied")
    );
    assert!(matches!(
        late_start,
        Err(AuthorityApplicationError::ForbiddenLifecycleTransition)
    ));
    assert_eq!(
        issued,
        IssuanceProcessingOutcome::Issued {
            challenge_id: challenge_id.clone(),
        }
    );
    assert!(matches!(
        pass_issued_registration,
        Err(AuthorityApplicationError::ForbiddenLifecycleTransition)
    ));
    server.stop();

    Ok(())
}

#[tokio::test]
async fn replacement_uses_fresh_operational_identity_and_authority_progress_after_restart()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let first_application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let first_adapter = first_application.simulated_pool_adapter();
    let first_server = RunningServer::spawn(bwg_core::authority::router(first_application)).await?;
    let (challenge_id, challenge_expires_at) = issue_challenge(
        &first_server.base_url,
        "action_worker_replacement_restart_01",
    )
    .await?;
    first_adapter
        .consent_default_pool_offer_for_simulation(&challenge_id)
        .await?;
    let failed_session = WorkSessionId::try_from("session_replaced_worker_01".to_owned())?;
    first_adapter
        .register_session(&challenge_id, failed_session.clone())
        .await?;
    let failed_lease = first_adapter
        .start_lease(
            &failed_session,
            WorkerClock::new("boot_replaced_worker_01", 0)?,
        )
        .await?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let credential_issuer = StratumCredentialIssuer::new([29_u8; 32]);
    let failed_credentials = stratum_credentials(
        &credential_issuer,
        failed_session.clone(),
        &failed_lease,
        "boot_replaced_worker_01",
        now,
        challenge_expires_at,
    )?;
    let first_registry = PostgresStratumSessionRegistry::connect(database.database_url()).await?;
    first_registry.register(&failed_credentials).await?;
    first_registry
        .reserve_extranonce(
            &failed_session,
            "00000000-0000-4000-8000-000000000101",
            "AABB",
            now,
        )
        .await?;
    first_adapter
        .report(
            accepted_event(
                "event_replaced_worker_01",
                "share_replaced_worker_01",
                failed_session.clone(),
                0xff,
                now,
            )?,
            &failed_lease,
            WorkerClock::new("boot_replaced_worker_01", 1)?,
        )
        .await?;
    first_adapter.fail_session(&failed_session).await?;
    drop(first_registry);
    first_server.stop();

    // Act
    let restarted =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let restarted_adapter = restarted.simulated_pool_adapter();
    let restarted_registry =
        PostgresStratumSessionRegistry::connect(database.database_url()).await?;
    let replacement_session = WorkSessionId::try_from("session_replacement_worker_01".to_owned())?;
    let replacement = restarted_adapter
        .replace_session(&failed_session, replacement_session.clone())
        .await?;
    let replacement_lease = restarted_adapter
        .start_lease(
            &replacement_session,
            WorkerClock::new("boot_replacement_worker_01", 0)?,
        )
        .await?;
    let replacement_credentials = stratum_credentials(
        &credential_issuer,
        replacement_session.clone(),
        &replacement_lease,
        "boot_replacement_worker_01",
        now + 2,
        challenge_expires_at,
    )?;
    restarted_registry
        .register(&replacement_credentials)
        .await?;
    let reused_extranonce = restarted_registry
        .reserve_extranonce(
            &replacement_session,
            "00000000-0000-4000-8000-000000000102",
            "AABB",
            now + 2,
        )
        .await;
    restarted_registry
        .reserve_extranonce(
            &replacement_session,
            "00000000-0000-4000-8000-000000000103",
            "CCDD",
            now + 2,
        )
        .await?;
    let authenticated_replacement = restarted_registry
        .authenticate(
            replacement_credentials.username(),
            replacement_credentials.secret(),
            now + 2,
        )
        .await?
        .ok_or("replacement credentials did not authenticate")?;
    let replacement_progress = restarted_adapter
        .report(
            accepted_event(
                "event_replacement_worker_01",
                "share_replacement_worker_01",
                replacement_session.clone(),
                0xff,
                now + 2,
            )?,
            &replacement_lease,
            WorkerClock::new("boot_replacement_worker_01", 1)?,
        )
        .await?;
    let recovered_replacement = restarted_adapter
        .maybe_session_replacement(&replacement_session)
        .await?
        .ok_or("replacement transition was not persisted")?;

    // Assert
    assert_eq!(replacement.generation(), 1);
    assert_eq!(replacement.reason().as_str(), "session_failed");
    assert_eq!(replacement.replaced_session_id(), &failed_session);
    assert_eq!(recovered_replacement, replacement);
    assert_ne!(replacement_lease.lease_id(), failed_lease.lease_id());
    assert_ne!(
        replacement_credentials.username(),
        failed_credentials.username()
    );
    assert_ne!(
        replacement_credentials.secret(),
        failed_credentials.secret()
    );
    assert!(matches!(
        reused_extranonce,
        Err(StratumV1Error::ExtranonceCollision)
    ));
    assert_eq!(authenticated_replacement.session_id(), &replacement_session);
    assert_eq!(
        replacement_progress.verified_progress().to_decimal_string(),
        "2199023255552"
    );

    Ok(())
}

#[tokio::test]
async fn disconnected_session_leaves_a_healthy_session_active_without_public_identity_leak()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let adapter = application.simulated_pool_adapter();
    let server = RunningServer::spawn(bwg_core::authority::router(application)).await?;
    let (challenge_id, _) =
        issue_challenge(&server.base_url, "action_isolated_worker_failure_01").await?;
    adapter
        .consent_default_pool_offer_for_simulation(&challenge_id)
        .await?;
    let disconnected_session =
        WorkSessionId::try_from("session_isolated_disconnect_01".to_owned())?;
    let healthy_session = WorkSessionId::try_from("session_isolated_healthy_01".to_owned())?;
    adapter
        .register_session(&challenge_id, disconnected_session.clone())
        .await?;
    adapter
        .register_session(&challenge_id, healthy_session.clone())
        .await?;
    let disconnected_lease = adapter
        .start_lease(
            &disconnected_session,
            WorkerClock::new("boot_isolated_disconnect_01", 0)?,
        )
        .await?;
    let healthy_lease = adapter
        .start_lease(
            &healthy_session,
            WorkerClock::new("boot_isolated_healthy_01", 0)?,
        )
        .await?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let disconnected_progress = adapter
        .report(
            accepted_event(
                "event_isolated_disconnect_01",
                "share_isolated_disconnect_01",
                disconnected_session.clone(),
                0xff,
                now,
            )?,
            &disconnected_lease,
            WorkerClock::new("boot_isolated_disconnect_01", 1)?,
        )
        .await?;

    // Act
    adapter.disconnected(&disconnected_session).await?;
    let healthy_progress = adapter
        .report(
            accepted_event(
                "event_isolated_healthy_01",
                "share_isolated_healthy_01",
                healthy_session.clone(),
                0xff,
                now + 1,
            )?,
            &healthy_lease,
            WorkerClock::new("boot_isolated_healthy_01", 1)?,
        )
        .await?;
    let disconnected_lifecycle = adapter.session_lifecycle(&disconnected_session).await?;
    let healthy_lifecycle = adapter.session_lifecycle(&healthy_session).await?;
    let public_lifecycle = reqwest::get(format!(
        "{}/v0/challenges/{}/lifecycle",
        server.base_url,
        challenge_id.as_str(),
    ))
    .await?
    .error_for_status()?
    .text()
    .await?;

    // Assert
    assert_eq!(
        disconnected_progress
            .verified_progress()
            .to_decimal_string(),
        "1099511627776"
    );
    assert_eq!(
        healthy_progress.verified_progress().to_decimal_string(),
        "2199023255552"
    );
    assert_eq!(
        disconnected_lifecycle.state(),
        SessionLifecycleState::Stopping
    );
    assert_eq!(
        disconnected_lifecycle.maybe_stop_reason(),
        Some("transport_disconnected")
    );
    assert_eq!(healthy_lifecycle.state(), SessionLifecycleState::Leased);
    assert!(public_lifecycle.contains("\"verified_progress\":\"2199023255552\""));
    for prohibited in [
        "session_isolated_disconnect_01",
        "session_isolated_healthy_01",
        "boot_isolated_disconnect_01",
        "boot_isolated_healthy_01",
    ] {
        assert!(!public_lifecycle.contains(prohibited));
    }
    server.stop();

    Ok(())
}

#[tokio::test]
async fn replacement_replay_is_idempotent_and_generation_fenced() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let adapter = application.simulated_pool_adapter();
    let server = RunningServer::spawn(bwg_core::authority::router(application)).await?;
    let (challenge_id, _) =
        issue_challenge(&server.base_url, "action_replacement_generation_01").await?;
    adapter
        .consent_default_pool_offer_for_simulation(&challenge_id)
        .await?;
    let first_session = WorkSessionId::try_from("session_generation_01".to_owned())?;
    let second_session = WorkSessionId::try_from("session_generation_02".to_owned())?;
    let third_session = WorkSessionId::try_from("session_generation_03".to_owned())?;
    adapter
        .register_session(&challenge_id, first_session.clone())
        .await?;
    adapter.fail_session(&first_session).await?;

    // Act
    let first_replacement = adapter
        .replace_session(&first_session, second_session.clone())
        .await?;
    let replayed = adapter
        .replace_session(&first_session, second_session.clone())
        .await?;
    let conflicting = adapter
        .replace_session(&first_session, third_session.clone())
        .await;
    adapter.fail_session(&second_session).await?;
    let second_replacement = adapter
        .replace_session(&second_session, third_session.clone())
        .await?;
    reqwest::Client::new()
        .post(format!(
            "{}/v0/challenges/{}/cancel",
            server.base_url,
            challenge_id.as_str(),
        ))
        .header(CLIENT_ID_HEADER, CLIENT_ID)
        .bearer_auth(SERVICE_SECRET)
        .json(&json!({ "confirm_progress_loss": true }))
        .send()
        .await?
        .error_for_status()?;
    let delayed_replay = adapter
        .replace_session(&second_session, third_session.clone())
        .await?;

    // Assert
    assert_eq!(replayed, first_replacement);
    assert_eq!(first_replacement.generation(), 1);
    assert_eq!(first_replacement.replaced_session_id(), &first_session);
    assert!(matches!(
        conflicting,
        Err(AuthorityApplicationError::ConflictingWorkSessionReplacement)
    ));
    assert_eq!(second_replacement.generation(), 2);
    assert_eq!(second_replacement.replaced_session_id(), &second_session);
    assert_eq!(second_replacement.session_id(), &third_session);
    assert_eq!(delayed_replay, second_replacement);
    server.stop();

    Ok(())
}

#[tokio::test]
async fn challenge_expiry_stops_a_ready_replacement_and_rejects_late_registration()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let adapter = application.simulated_pool_adapter();
    let server = RunningServer::spawn(bwg_core::authority::router(application)).await?;
    let (challenge_id, challenge_expires_at) =
        issue_challenge(&server.base_url, "action_expired_replacement_race_01").await?;
    adapter
        .consent_default_pool_offer_for_simulation(&challenge_id)
        .await?;
    let active_session = WorkSessionId::try_from("session_expired_active_01".to_owned())?;
    let ready_replacement = WorkSessionId::try_from("session_expired_ready_01".to_owned())?;
    adapter
        .register_session(&challenge_id, active_session.clone())
        .await?;
    adapter
        .register_session(&challenge_id, ready_replacement.clone())
        .await?;
    let active_lease = adapter
        .start_lease(
            &active_session,
            WorkerClock::new("boot_expired_active_01", 0)?,
        )
        .await?;

    // Act
    let expired_work = adapter
        .report(
            accepted_event(
                "event_expired_replacement_race_01",
                "share_expired_replacement_race_01",
                active_session,
                0xff,
                challenge_expires_at,
            )?,
            &active_lease,
            WorkerClock::new("boot_expired_active_01", 1)?,
        )
        .await;
    let ready_lifecycle = adapter.session_lifecycle(&ready_replacement).await?;
    let late_registration = adapter
        .register_session(
            &challenge_id,
            WorkSessionId::try_from("session_expired_late_01".to_owned())?,
        )
        .await;

    // Assert
    assert!(matches!(
        expired_work,
        Err(AuthorityApplicationError::Progress(
            ProgressError::ChallengeExpired
        ))
    ));
    assert_eq!(ready_lifecycle.state(), SessionLifecycleState::Stopping);
    assert_eq!(
        ready_lifecycle.maybe_stop_reason(),
        Some("challenge_expired")
    );
    assert!(matches!(
        late_registration,
        Err(AuthorityApplicationError::ForbiddenLifecycleTransition)
    ));
    server.stop();

    Ok(())
}

async fn issue_challenge(
    authority_url: &str,
    action_reference: &str,
) -> Result<(ChallengeId, u64), Box<dyn Error>> {
    let response = reqwest::Client::new()
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
        .json::<Value>()
        .await?;
    let challenge_id = ChallengeId::try_from(
        response["challenge_id"]
            .as_str()
            .ok_or("challenge response needs an identifier")?
            .to_owned(),
    )?;
    let expires_at = response["expires_at_unix_seconds"]
        .as_u64()
        .ok_or("challenge response needs an expiry")?;
    Ok((challenge_id, expires_at))
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
