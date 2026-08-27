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
    progress::WorkSessionId,
    stratum_v1::{PostgresStratumSessionRegistry, StratumCredentialIssuer},
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

const CLIENT_ID: &str = "multi-session-reference-service";
const SERVICE_SECRET: &str = "multi-session-secret-P9vK2mQ7xR4tY8uN3cF6wL1zA5dH0sJ";
const AUTHORITY_SIGNING_SEED: &str = "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A";

#[tokio::test]
async fn concurrent_sessions_cross_one_threshold_and_recover_one_issuance()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let adapter = application.simulated_pool_adapter();
    let server = RunningServer::spawn(bwg_core::authority::router(application)).await?;
    let (challenge_id, challenge_expires_at) =
        issue_challenge(&server.base_url, "action_multi_session_threshold_01").await?;
    adapter
        .consent_default_pool_offer_for_simulation(&challenge_id)
        .await?;
    let first_session = WorkSessionId::try_from("session_multi_threshold_01".to_owned())?;
    let second_session = WorkSessionId::try_from("session_multi_threshold_02".to_owned())?;
    adapter
        .register_session(&challenge_id, first_session.clone())
        .await?;
    adapter
        .register_session(&challenge_id, second_session.clone())
        .await?;
    let first_lease = adapter
        .start_lease(
            &first_session,
            WorkerClock::new("boot_multi_threshold_01", 0)?,
        )
        .await?;
    let second_lease = adapter
        .start_lease(
            &second_session,
            WorkerClock::new("boot_multi_threshold_02", 0)?,
        )
        .await?;
    let received_at = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let credential_issuer = StratumCredentialIssuer::new([23_u8; 32]);
    let credential_registry =
        PostgresStratumSessionRegistry::connect(database.database_url()).await?;
    let first_credentials = stratum_credentials(
        &credential_issuer,
        first_session.clone(),
        &first_lease,
        "boot_multi_threshold_01",
        received_at,
        challenge_expires_at,
    )?;
    let second_credentials = stratum_credentials(
        &credential_issuer,
        second_session.clone(),
        &second_lease,
        "boot_multi_threshold_02",
        received_at,
        challenge_expires_at,
    )?;
    credential_registry.register(&first_credentials).await?;
    credential_registry.register(&second_credentials).await?;
    let first_event = accepted_event(
        "event_multi_threshold_01",
        "share_multi_threshold_01",
        first_session.clone(),
        0x7f,
        received_at,
    )?;
    let second_event = accepted_event(
        "event_multi_threshold_02",
        "share_multi_threshold_02",
        second_session.clone(),
        0x5f,
        received_at,
    )?;

    // Act
    let authenticated_first = credential_registry
        .authenticate(
            first_credentials.username(),
            first_credentials.secret(),
            received_at,
        )
        .await?
        .ok_or("first Stratum credentials did not authenticate")?;
    let authenticated_second = credential_registry
        .authenticate(
            second_credentials.username(),
            second_credentials.secret(),
            received_at,
        )
        .await?
        .ok_or("second Stratum credentials did not authenticate")?;
    let (first, second) = tokio::join!(
        adapter.report(
            first_event,
            &first_lease,
            WorkerClock::new("boot_multi_threshold_01", 1)?,
        ),
        adapter.report(
            second_event,
            &second_lease,
            WorkerClock::new("boot_multi_threshold_02", 1)?,
        ),
    );
    let first = first?;
    let second = second?;
    server.stop();
    let restarted =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let issuance_worker = IssuanceWorkerId::try_from("worker_multi_threshold_01".to_owned())?;
    let issued = restarted
        .process_next_issuance(&issuance_worker, received_at)
        .await?;
    let repeated = restarted
        .process_next_issuance(&issuance_worker, received_at + 1)
        .await?;

    // Assert
    assert_ne!(first_lease.lease_id(), second_lease.lease_id());
    assert_ne!(first_credentials.username(), second_credentials.username());
    assert_ne!(first_credentials.secret(), second_credentials.secret());
    assert_eq!(authenticated_first.session_id(), &first_session);
    assert_eq!(authenticated_second.session_id(), &second_session);
    let mut credited = [first.maybe_credited_work(), second.maybe_credited_work()]
        .map(|maybe_work| maybe_work.ok_or("concurrent event was not credited"))
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|work| work.to_decimal_string())
        .collect::<Vec<_>>();
    credited.sort();
    assert_eq!(credited, ["2199023255552", "2932031007402"]);
    let mut progress = [first.verified_progress(), second.verified_progress()]
        .map(|value| value.to_decimal_string());
    progress.sort();
    assert_eq!(progress[1], "5131054262954");
    assert_eq!(
        [
            first.issuance_intent_created(),
            second.issuance_intent_created()
        ]
        .into_iter()
        .filter(|created| *created)
        .count(),
        1
    );
    assert_eq!(
        issued,
        IssuanceProcessingOutcome::Issued {
            challenge_id: challenge_id.clone(),
        }
    );
    assert_eq!(repeated, IssuanceProcessingOutcome::NoWork);

    Ok(())
}

#[tokio::test]
async fn failed_session_progress_survives_restart_and_a_successive_session()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let first_application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let first_adapter = first_application.simulated_pool_adapter();
    let first_server = RunningServer::spawn(bwg_core::authority::router(first_application)).await?;
    let (challenge_id, _) =
        issue_challenge(&first_server.base_url, "action_multi_session_successive_01").await?;
    first_adapter
        .consent_default_pool_offer_for_simulation(&challenge_id)
        .await?;
    let first_session = WorkSessionId::try_from("session_multi_successive_01".to_owned())?;
    first_adapter
        .register_session(&challenge_id, first_session.clone())
        .await?;
    let first_lease = first_adapter
        .start_lease(
            &first_session,
            WorkerClock::new("boot_multi_successive_01", 0)?,
        )
        .await?;
    let received_at = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let first = first_adapter
        .report(
            accepted_event(
                "event_multi_successive_01",
                "share_multi_successive_01",
                first_session.clone(),
                0xff,
                received_at,
            )?,
            &first_lease,
            WorkerClock::new("boot_multi_successive_01", 1)?,
        )
        .await?;
    first_adapter.fail_session(&first_session).await?;
    let failed = first_adapter.session_lifecycle(&first_session).await?;
    first_server.stop();

    // Act
    let restarted =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let restarted_adapter = restarted.simulated_pool_adapter();
    let second_session = WorkSessionId::try_from("session_multi_successive_02".to_owned())?;
    restarted_adapter
        .register_session(&challenge_id, second_session.clone())
        .await?;
    let second_lease = restarted_adapter
        .start_lease(
            &second_session,
            WorkerClock::new("boot_multi_successive_02", 0)?,
        )
        .await?;
    let second = restarted_adapter
        .report(
            accepted_event(
                "event_multi_successive_02",
                "share_multi_successive_02",
                second_session,
                0xff,
                received_at + 1,
            )?,
            &second_lease,
            WorkerClock::new("boot_multi_successive_02", 1)?,
        )
        .await?;

    // Assert
    assert_eq!(failed.state(), SessionLifecycleState::Failed);
    assert_eq!(
        first
            .maybe_credited_work()
            .ok_or("first session was not credited")?
            .to_decimal_string(),
        "1099511627776"
    );
    assert_eq!(
        second
            .maybe_credited_work()
            .ok_or("second session was not credited")?
            .to_decimal_string(),
        "1099511627776"
    );
    assert_eq!(
        second.verified_progress().to_decimal_string(),
        "2199023255552"
    );
    assert!(!first.issuance_intent_created());
    assert!(!second.issuance_intent_created());

    Ok(())
}

#[tokio::test]
async fn event_identity_conflict_across_sessions_cannot_change_progress()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let adapter = application.simulated_pool_adapter();
    let server = RunningServer::spawn(bwg_core::authority::router(application)).await?;
    let (challenge_id, _) =
        issue_challenge(&server.base_url, "action_multi_session_conflict_01").await?;
    adapter
        .consent_default_pool_offer_for_simulation(&challenge_id)
        .await?;
    let first_session = WorkSessionId::try_from("session_multi_conflict_01".to_owned())?;
    let second_session = WorkSessionId::try_from("session_multi_conflict_02".to_owned())?;
    adapter
        .register_session(&challenge_id, first_session.clone())
        .await?;
    adapter
        .register_session(&challenge_id, second_session.clone())
        .await?;
    let first_lease = adapter
        .start_lease(
            &first_session,
            WorkerClock::new("boot_multi_conflict_01", 0)?,
        )
        .await?;
    let second_lease = adapter
        .start_lease(
            &second_session,
            WorkerClock::new("boot_multi_conflict_02", 0)?,
        )
        .await?;
    let received_at = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let first = adapter
        .report(
            accepted_event(
                "event_multi_conflict_01",
                "share_multi_conflict_01",
                first_session,
                0xff,
                received_at,
            )?,
            &first_lease,
            WorkerClock::new("boot_multi_conflict_01", 1)?,
        )
        .await?;
    let conflicting_event = accepted_event(
        "event_multi_conflict_01",
        "share_multi_conflict_02",
        second_session.clone(),
        0xfe,
        received_at + 1,
    )?;

    // Act
    let conflict = adapter
        .report(
            conflicting_event,
            &second_lease,
            WorkerClock::new("boot_multi_conflict_02", 1)?,
        )
        .await;
    let accepted_after_conflict = adapter
        .report(
            accepted_event(
                "event_multi_conflict_02",
                "share_multi_conflict_03",
                second_session,
                0xff,
                received_at + 2,
            )?,
            &second_lease,
            WorkerClock::new("boot_multi_conflict_02", 2)?,
        )
        .await?;

    // Assert
    assert!(matches!(
        conflict,
        Err(AuthorityApplicationError::ConflictingEventReplay)
    ));
    assert_eq!(
        first.verified_progress().to_decimal_string(),
        "1099511627776"
    );
    assert_eq!(
        accepted_after_conflict
            .verified_progress()
            .to_decimal_string(),
        "2199023255552"
    );

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
