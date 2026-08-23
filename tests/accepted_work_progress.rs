use std::time::Duration;

use axum::Router;
use bwg_core::{
    authority::{
        self, AuthorityApplication, AuthorityApplicationError, AuthorityPublicConfig,
        CLIENT_ID_HEADER, Config, DeploymentEnvironment, ServiceCredential,
    },
    challenge::{ActionPolicy, ChallengeId},
    progress::{
        AcceptedWorkEvent, AcceptedWorkEventId, AcceptedWorkEventInput, ChallengeProgress,
        NetworkTargetOutcome, ReceiptTime, ShareFingerprint, WorkSessionId, WorkerReport,
    },
    work::CreditedWork,
};
use serde_json::{Value, json};
use tokio::{net::TcpListener, time::timeout};

#[path = "support/authority_keys.rs"]
mod authority_key_support;
#[path = "support/postgres.rs"]
mod postgres_support;
use authority_key_support::{CLAIMANT_PUBLIC_JWK, authority_keys};
use postgres_support::PostgresTestDatabase;

const CLIENT_ID: &str = "progress-reference-service";
const SERVICE_SECRET: &str = "progress-secret-P9vK2mQ7xR4tY8uN3cF6wL1zA5dH0sJ";

#[test]
fn assigned_target_is_the_only_source_of_credited_work() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let required_work = CreditedWork::try_from("4398046511104".to_owned())?;
    let session_id = WorkSessionId::try_from("session_crypto_01".to_owned())?;
    let mut progress = ChallengeProgress::new(required_work);
    progress.register_session(session_id.clone())?;
    let event = AcceptedWorkEvent::try_from(AcceptedWorkEventInput {
        event_id: AcceptedWorkEventId::try_from("event_accepted_01".to_owned())?,
        work_session_id: session_id,
        assigned_target: difficulty_one_target(),
        received_at: ReceiptTime::try_from(1_787_443_200_u64)?,
        share_fingerprint: ShareFingerprint::try_from("share_fingerprint_01".to_owned())?,
        network_target_outcome: NetworkTargetOutcome::BelowNetworkTarget,
        maybe_worker_report: Some(WorkerReport {
            reported_hashes: "999999999999999999999999999999".to_owned(),
            reported_hashrate_hs: 9.99e30,
            lucky_hash_leading_zero_bits: 255,
        }),
    })?;

    // Act
    let acknowledgement = progress.accept(event)?;

    // Assert
    assert_eq!(
        acknowledgement
            .maybe_credited_work()
            .map(CreditedWork::to_decimal_string),
        Some("4295032833".to_owned())
    );
    assert_eq!(
        acknowledgement.verified_progress().to_decimal_string(),
        "4295032833"
    );

    Ok(())
}

#[test]
fn replayed_event_returns_identical_acknowledgement_without_double_credit()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let required_work = CreditedWork::try_from("4398046511104".to_owned())?;
    let session_id = WorkSessionId::try_from("session_replay_01".to_owned())?;
    let mut progress = ChallengeProgress::new(required_work);
    progress.register_session(session_id.clone())?;
    let event = difficulty_one_event("event_replay_01", session_id, "share_replay_01")?;

    // Act
    let first = progress.accept(event.clone())?;
    let replayed = progress.accept(event)?;

    // Assert
    assert_eq!(replayed, first);
    assert_eq!(
        progress.verified_progress().to_decimal_string(),
        "4295032833"
    );

    Ok(())
}

#[test]
fn duplicate_share_fingerprint_never_advances_progress_twice()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let required_work = CreditedWork::try_from("4398046511104".to_owned())?;
    let session_id = WorkSessionId::try_from("session_duplicate_01".to_owned())?;
    let mut progress = ChallengeProgress::new(required_work);
    progress.register_session(session_id.clone())?;
    let first = difficulty_one_event(
        "event_duplicate_01",
        session_id.clone(),
        "share_duplicate_01",
    )?;
    let duplicate = difficulty_one_event("event_duplicate_02", session_id, "share_duplicate_01")?;

    // Act
    progress.accept(first)?;
    let duplicate_acknowledgement = progress.accept(duplicate.clone())?;
    let replayed_duplicate = progress.accept(duplicate)?;

    // Assert
    assert_eq!(
        duplicate_acknowledgement.disposition(),
        bwg_core::progress::AcceptedWorkDisposition::DuplicateShare
    );
    assert_eq!(duplicate_acknowledgement.maybe_credited_work(), None);
    assert_eq!(replayed_duplicate, duplicate_acknowledgement);
    assert_eq!(
        progress.verified_progress().to_decimal_string(),
        "4295032833"
    );

    Ok(())
}

#[tokio::test]
async fn verified_progress_streams_separately_from_activity_estimate()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let adapter = application.simulated_pool_adapter();
    let authority_url = spawn_http(authority::router(application)).await?;
    let challenge = reqwest::Client::new()
        .post(format!("{authority_url}/v0/challenges"))
        .header(CLIENT_ID_HEADER, CLIENT_ID)
        .bearer_auth(SERVICE_SECRET)
        .json(&json!({
            "action_policy": "account-creation.light.v1",
            "action_reference": "action_progress_01",
            "claimant_key": CLAIMANT_PUBLIC_JWK
        }))
        .send()
        .await?
        .json::<Value>()
        .await?;
    let challenge_id = challenge["challenge_id"]
        .as_str()
        .ok_or("challenge response needs an identifier")?;
    let progress_challenge_id = ChallengeId::try_from(challenge_id.to_owned())?;
    let session_id = WorkSessionId::try_from("session_stream_01".to_owned())?;
    adapter
        .register_session(&progress_challenge_id, session_id.clone())
        .await?;
    let mut stream = reqwest::get(format!(
        "{authority_url}/v0/challenges/{challenge_id}/events"
    ))
    .await?;
    let initial = timeout(Duration::from_secs(2), stream.chunk())
        .await??
        .ok_or("progress stream ended before its snapshot")?;

    // Act
    let acknowledgement = adapter
        .report(difficulty_one_event(
            "event_stream_01",
            session_id,
            "share_stream_01",
        )?)
        .await?;
    let updated = timeout(Duration::from_secs(2), stream.chunk())
        .await??
        .ok_or("progress stream ended before its update")?;

    // Assert
    let initial_text = String::from_utf8(initial.to_vec())?;
    let updated_text = String::from_utf8(updated.to_vec())?;
    assert!(initial_text.contains("\"verified_progress\":\"0\""));
    assert!(initial_text.contains("\"activity_estimate\":{\"status\":\"unavailable\"}"));
    assert!(updated_text.contains("\"verified_progress\":\"4295032833\""));
    assert_eq!(
        acknowledgement.verified_progress().to_decimal_string(),
        "4295032833"
    );

    Ok(())
}

#[tokio::test]
async fn work_received_at_challenge_expiry_cannot_advance_progress()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let adapter = application.simulated_pool_adapter();
    let authority_url = spawn_http(authority::router(application)).await?;
    let challenge = reqwest::Client::new()
        .post(format!("{authority_url}/v0/challenges"))
        .header(CLIENT_ID_HEADER, CLIENT_ID)
        .bearer_auth(SERVICE_SECRET)
        .json(&json!({
            "action_policy": "account-creation.light.v1",
            "action_reference": "action_expired_progress_01",
            "claimant_key": CLAIMANT_PUBLIC_JWK
        }))
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    let challenge_id = ChallengeId::try_from(
        challenge["challenge_id"]
            .as_str()
            .ok_or("challenge response needs an identifier")?
            .to_owned(),
    )?;
    let challenge_expiry = challenge["expires_at_unix_seconds"]
        .as_u64()
        .ok_or("challenge response needs an expiry")?;
    let session_id = WorkSessionId::try_from("session_expired_progress_01".to_owned())?;
    adapter
        .register_session(&challenge_id, session_id.clone())
        .await?;
    let event = AcceptedWorkEvent::try_from(AcceptedWorkEventInput {
        event_id: AcceptedWorkEventId::try_from("event_expired_progress_01".to_owned())?,
        work_session_id: session_id,
        assigned_target: difficulty_one_target(),
        received_at: ReceiptTime::try_from(challenge_expiry)?,
        share_fingerprint: ShareFingerprint::try_from("share_expired_progress_01".to_owned())?,
        network_target_outcome: NetworkTargetOutcome::BelowNetworkTarget,
        maybe_worker_report: None,
    })?;

    // Act
    let result = adapter.report(event).await;

    // Assert
    assert!(matches!(
        result,
        Err(AuthorityApplicationError::Progress(
            bwg_core::progress::ProgressError::ChallengeExpired
        ))
    ));

    Ok(())
}

fn difficulty_one_event(
    event_id: &str,
    session_id: WorkSessionId,
    share_fingerprint: &str,
) -> Result<AcceptedWorkEvent, Box<dyn std::error::Error>> {
    Ok(AcceptedWorkEvent::try_from(AcceptedWorkEventInput {
        event_id: AcceptedWorkEventId::try_from(event_id.to_owned())?,
        work_session_id: session_id,
        assigned_target: difficulty_one_target(),
        received_at: ReceiptTime::try_from(1_787_443_200_u64)?,
        share_fingerprint: ShareFingerprint::try_from(share_fingerprint.to_owned())?,
        network_target_outcome: NetworkTargetOutcome::BelowNetworkTarget,
        maybe_worker_report: None,
    })?)
}

fn difficulty_one_target() -> [u8; 32] {
    let mut target = [0_u8; 32];
    target[4] = 0xff;
    target[5] = 0xff;
    target
}

fn authority_config() -> Result<Config, Box<dyn std::error::Error>> {
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
