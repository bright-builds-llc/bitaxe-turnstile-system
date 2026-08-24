use std::{
    error::Error,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::Router;
use bwg_core::{
    authority::{
        self, AuthorityApplication, AuthorityApplicationError, AuthorityPublicConfig,
        CLAIMANT_PROOF_HEADER, CLIENT_ID_HEADER, Config, DeploymentEnvironment,
        IssuanceProcessingOutcome, IssuanceWorkerId, ServiceCredential, SimulatedPoolAdapter,
    },
    challenge::{ActionPolicy, ChallengeId},
    crypto_profile::{AuthorityKeySet, verify_gate_pass},
    lifecycle::WorkerClock,
    progress::{
        AcceptedWorkEvent, AcceptedWorkEventId, AcceptedWorkEventInput, NetworkTargetOutcome,
        ReceiptTime, ShareFingerprint, WorkSessionId,
    },
};
use serde_json::{Value, json};
use tokio::{net::TcpListener, task::JoinHandle, time::timeout};

#[path = "support/authority_keys.rs"]
mod authority_key_support;
#[path = "support/claimant.rs"]
mod claimant_support;
#[path = "authority_persistence/governance.rs"]
mod governance;
#[path = "support/http.rs"]
mod http_support;
#[path = "authority_persistence/lifecycle.rs"]
mod lifecycle;
#[path = "support/postgres.rs"]
mod postgres_support;

use authority_key_support::{CLAIMANT_PUBLIC_JWK, authority_keys};
use claimant_support::Claimant;
use http_support::send_get_without_reading_response;
use postgres_support::PostgresTestDatabase;

const CLIENT_ID: &str = "persistence-reference-service";
const SERVICE_SECRET: &str = "persistence-secret-P9vK2mQ7xR4tY8uN3cF6wL1zA5dH0sJ";
const AUTHORITY_SIGNING_SEED: &str = "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A";

#[tokio::test]
async fn issued_challenge_remains_observable_after_authority_restart() -> Result<(), Box<dyn Error>>
{
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let first_application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let first_server = RunningServer::spawn(authority::router(first_application)).await?;
    let challenge = issue_challenge(&first_server.base_url, CLAIMANT_PUBLIC_JWK).await?;
    let challenge_id = challenge["challenge_id"]
        .as_str()
        .ok_or("challenge response needs an identifier")?
        .to_owned();
    first_server.stop();

    // Act
    let restarted_application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let restarted_server = RunningServer::spawn(authority::router(restarted_application)).await?;
    let mut response = reqwest::get(format!(
        "{}/v0/challenges/{challenge_id}/events",
        restarted_server.base_url
    ))
    .await?;
    let snapshot = timeout(Duration::from_secs(2), response.chunk())
        .await??
        .ok_or("progress stream ended before its snapshot")?;

    // Assert
    let snapshot = String::from_utf8(snapshot.to_vec())?;
    assert!(snapshot.contains("\"verified_progress\":\"0\""));
    assert!(snapshot.contains("\"work_requirement\":\"4398046511104\""));

    Ok(())
}

#[tokio::test]
async fn accepted_threshold_event_replays_identically_after_authority_restart()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let first_application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let first_adapter = first_application.simulated_pool_adapter();
    let first_server = RunningServer::spawn(authority::router(first_application)).await?;
    let challenge = issue_challenge(&first_server.base_url, CLAIMANT_PUBLIC_JWK).await?;
    let challenge_id = ChallengeId::try_from(
        challenge["challenge_id"]
            .as_str()
            .ok_or("challenge response needs an identifier")?
            .to_owned(),
    )?;
    let session_id = WorkSessionId::try_from("session_persistence_01".to_owned())?;
    register_test_session(&first_adapter, &challenge_id, session_id.clone()).await?;
    let lease = first_adapter
        .start_lease(&session_id, WorkerClock::new("boot_persistence_01", 0)?)
        .await?;
    let event = light_target_event(session_id)?;
    let accepted = first_adapter
        .report(
            event.clone(),
            &lease,
            WorkerClock::new("boot_persistence_01", 1)?,
        )
        .await?;
    first_server.stop();

    // Act
    let restarted_application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let restarted_adapter = restarted_application.simulated_pool_adapter();
    let replayed = restarted_adapter
        .report(
            event,
            &lease,
            WorkerClock::new("boot_persistence_01", 60_000)?,
        )
        .await?;

    // Assert
    assert!(accepted.issuance_intent_created());
    assert_eq!(replayed, accepted);
    assert_eq!(
        replayed.verified_progress().to_decimal_string(),
        "4398046511104"
    );

    Ok(())
}

#[tokio::test]
async fn expired_signing_lease_recovers_one_exact_pass_across_restart() -> Result<(), Box<dyn Error>>
{
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let first_application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let first_adapter = first_application.simulated_pool_adapter();
    let first_server = RunningServer::spawn(authority::router(first_application.clone())).await?;
    let claimant = Claimant::generate()?;
    let challenge = issue_challenge(&first_server.base_url, &claimant.public_jwk_json).await?;
    let challenge_id = ChallengeId::try_from(
        challenge["challenge_id"]
            .as_str()
            .ok_or("challenge response needs an identifier")?
            .to_owned(),
    )?;
    let session_id = WorkSessionId::try_from("session_lease_recovery_01".to_owned())?;
    register_test_session(&first_adapter, &challenge_id, session_id.clone()).await?;
    let lease = first_adapter
        .start_lease(&session_id, WorkerClock::new("boot_lease_recovery_01", 0)?)
        .await?;
    let event = light_target_event_with_id(
        "event_lease_recovery_01",
        "share_lease_recovery_01",
        session_id,
    )?;
    let accepted_at = event.received_at_unix_seconds();
    first_adapter
        .report(
            event,
            &lease,
            WorkerClock::new("boot_lease_recovery_01", 1)?,
        )
        .await?;
    let first_worker = IssuanceWorkerId::try_from("worker_first_01".to_owned())?;
    let unavailable_application = AuthorityApplication::connect_postgres(
        authority_config_without_signer()?,
        database.database_url(),
    )
    .await?;
    let signing_failure = unavailable_application
        .process_next_issuance(&first_worker, accepted_at)
        .await;
    assert!(matches!(
        signing_failure,
        Err(AuthorityApplicationError::SigningUnavailable)
    ));
    first_server.stop();

    // Act
    let replacement = AuthorityApplication::connect_postgres(
        authority_config_with_signer_for_issuer("https://rotated-authority.example")?,
        database.database_url(),
    )
    .await?;
    let replacement_worker = IssuanceWorkerId::try_from("worker_replacement_01".to_owned())?;
    let before_lease_expiry = replacement
        .process_next_issuance(&replacement_worker, accepted_at + 1)
        .await?;
    let recovered = replacement
        .process_next_issuance(&replacement_worker, accepted_at + 31)
        .await?;
    let replacement_server = RunningServer::spawn(authority::router(replacement)).await?;
    let public_lookup_url = format!(
        "https://authority.example/v0/challenges/{}/gate-pass",
        challenge_id.as_str()
    );
    let request_lookup_url = format!(
        "{}/v0/challenges/{}/gate-pass",
        replacement_server.base_url,
        challenge_id.as_str()
    );
    let proof_now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let first_proof = claimant.sign_issuance_proof(
        &public_lookup_url,
        challenge_id.as_str(),
        "proof_lease_recovery_01",
        proof_now,
    )?;
    let first_lookup = reqwest::Client::new()
        .get(&request_lookup_url)
        .header(CLAIMANT_PROOF_HEADER, first_proof)
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    replacement_server.stop();
    let restarted = AuthorityApplication::connect_postgres(
        authority_config_with_signer_for_issuer("https://rotated-authority.example")?,
        database.database_url(),
    )
    .await?;
    let restarted_server = RunningServer::spawn(authority::router(restarted)).await?;
    let repeated_proof = claimant.sign_issuance_proof(
        &public_lookup_url,
        challenge_id.as_str(),
        "proof_lease_recovery_02",
        proof_now,
    )?;
    let repeated_lookup = reqwest::Client::new()
        .get(format!(
            "{}/v0/challenges/{}/gate-pass",
            restarted_server.base_url,
            challenge_id.as_str()
        ))
        .header(CLAIMANT_PROOF_HEADER, repeated_proof)
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;

    // Assert
    assert_eq!(before_lease_expiry, IssuanceProcessingOutcome::NoWork);
    assert_eq!(
        recovered,
        IssuanceProcessingOutcome::Issued {
            challenge_id: challenge_id.clone()
        }
    );
    assert_eq!(first_lookup["status"], "issued");
    assert_eq!(first_lookup, repeated_lookup);
    let gate_pass = first_lookup["gate_pass"]
        .as_str()
        .ok_or("issued lookup needs a Gate Pass")?;
    let keys = AuthorityKeySet::try_from(authority_keys()?)?;
    let verified = verify_gate_pass(gate_pass, keys.keys())?;
    assert_eq!(verified.issuer(), "https://authority.example");
    assert_eq!(verified.protected_action_type(), "account_creation");
    assert_eq!(verified.action_policy(), "account-creation.light.v1");

    Ok(())
}

#[tokio::test]
async fn issuance_lookup_requires_fresh_claimant_proof_and_returns_identical_bytes()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let application = AuthorityApplication::connect_postgres(
        authority_config_with_signer()?,
        database.database_url(),
    )
    .await?;
    let adapter = application.simulated_pool_adapter();
    let server = RunningServer::spawn(authority::router(application.clone())).await?;
    let claimant = Claimant::generate()?;
    let challenge = issue_challenge(&server.base_url, &claimant.public_jwk_json).await?;
    let challenge_id = ChallengeId::try_from(
        challenge["challenge_id"]
            .as_str()
            .ok_or("challenge response needs an identifier")?
            .to_owned(),
    )?;
    let session_id = WorkSessionId::try_from("session_proof_lookup_01".to_owned())?;
    register_test_session(&adapter, &challenge_id, session_id.clone()).await?;
    let lease = adapter
        .start_lease(&session_id, WorkerClock::new("boot_proof_lookup_01", 0)?)
        .await?;
    let event =
        light_target_event_with_id("event_proof_lookup_01", "share_proof_lookup_01", session_id)?;
    let issued_at = event.received_at_unix_seconds();
    adapter
        .report(event, &lease, WorkerClock::new("boot_proof_lookup_01", 1)?)
        .await?;
    let worker_id = IssuanceWorkerId::try_from("worker_proof_lookup_01".to_owned())?;
    application
        .process_next_issuance(&worker_id, issued_at)
        .await?;
    let public_lookup_url = format!(
        "https://authority.example/v0/challenges/{}/gate-pass",
        challenge_id.as_str()
    );
    let request_url = format!(
        "{}/v0/challenges/{}/gate-pass",
        server.base_url,
        challenge_id.as_str()
    );
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let first_proof = claimant.sign_issuance_proof(
        &public_lookup_url,
        challenge_id.as_str(),
        "proof_issuance_lookup_01",
        now,
    )?;
    let missing_proof = reqwest::get(&request_url).await?;
    let wrong_claimant = Claimant::generate()?;
    let wrong_key_proof = wrong_claimant.sign_issuance_proof(
        &public_lookup_url,
        challenge_id.as_str(),
        "proof_issuance_wrong_key_01",
        now,
    )?;
    let wrong_key = reqwest::Client::new()
        .get(&request_url)
        .header(CLAIMANT_PROOF_HEADER, wrong_key_proof)
        .send()
        .await?;
    let stale_proof = claimant.sign_issuance_proof(
        &public_lookup_url,
        challenge_id.as_str(),
        "proof_issuance_stale_01",
        now.saturating_sub(61),
    )?;
    let stale = reqwest::Client::new()
        .get(&request_url)
        .header(CLAIMANT_PROOF_HEADER, stale_proof)
        .send()
        .await?;

    // Act
    let lost_response_stream =
        send_get_without_reading_response(&request_url, CLAIMANT_PROOF_HEADER, &first_proof)?;
    tokio::time::sleep(Duration::from_millis(50)).await;
    drop(lost_response_stream);
    let replay = reqwest::Client::new()
        .get(&request_url)
        .header(CLAIMANT_PROOF_HEADER, &first_proof)
        .send()
        .await?;
    let retry_proof = claimant.sign_issuance_proof(
        &public_lookup_url,
        challenge_id.as_str(),
        "proof_issuance_lookup_02",
        now,
    )?;
    let retry_body = reqwest::Client::new()
        .get(&request_url)
        .header(CLAIMANT_PROOF_HEADER, retry_proof)
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    let repeated_proof = claimant.sign_issuance_proof(
        &public_lookup_url,
        challenge_id.as_str(),
        "proof_issuance_lookup_03",
        now,
    )?;
    let repeated_body = reqwest::Client::new()
        .get(&request_url)
        .header(CLAIMANT_PROOF_HEADER, repeated_proof)
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;

    // Assert
    assert_eq!(missing_proof.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert_eq!(wrong_key.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert_eq!(stale.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert_eq!(replay.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert_eq!(retry_body, repeated_body);

    Ok(())
}

#[tokio::test]
async fn concurrent_duplicate_share_is_credited_only_once() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let adapter = application.simulated_pool_adapter();
    let server = RunningServer::spawn(authority::router(application)).await?;
    let challenge = issue_challenge(&server.base_url, CLAIMANT_PUBLIC_JWK).await?;
    let challenge_id = ChallengeId::try_from(
        challenge["challenge_id"]
            .as_str()
            .ok_or("challenge response needs an identifier")?
            .to_owned(),
    )?;
    let first_session = WorkSessionId::try_from("session_concurrent_share_01".to_owned())?;
    let second_session = WorkSessionId::try_from("session_concurrent_share_02".to_owned())?;
    register_test_session(&adapter, &challenge_id, first_session.clone()).await?;
    register_test_session(&adapter, &challenge_id, second_session.clone()).await?;
    let first_lease = adapter
        .start_lease(
            &first_session,
            WorkerClock::new("boot_concurrent_share_01", 0)?,
        )
        .await?;
    let second_lease = adapter
        .start_lease(
            &second_session,
            WorkerClock::new("boot_concurrent_share_02", 0)?,
        )
        .await?;
    let first_event = difficulty_one_event(
        "event_concurrent_share_01",
        "share_concurrent_duplicate_01",
        first_session,
    )?;
    let second_event = difficulty_one_event(
        "event_concurrent_share_02",
        "share_concurrent_duplicate_01",
        second_session,
    )?;

    // Act
    let (first, second) = tokio::join!(
        adapter.report(
            first_event,
            &first_lease,
            WorkerClock::new("boot_concurrent_share_01", 1)?,
        ),
        adapter.report(
            second_event,
            &second_lease,
            WorkerClock::new("boot_concurrent_share_02", 1)?,
        ),
    );
    let first = first?;
    let second = second?;

    // Assert
    assert_eq!(
        [first.maybe_credited_work(), second.maybe_credited_work()]
            .into_iter()
            .flatten()
            .count(),
        1
    );
    assert_eq!(first.verified_progress().to_decimal_string(), "4295032833");
    assert_eq!(second.verified_progress(), first.verified_progress());
    assert!(!first.issuance_intent_created());
    assert!(!second.issuance_intent_created());

    Ok(())
}

async fn issue_challenge(authority_url: &str, claimant_key: &str) -> Result<Value, Box<dyn Error>> {
    let response = reqwest::Client::new()
        .post(format!("{authority_url}/v0/challenges"))
        .header(CLIENT_ID_HEADER, CLIENT_ID)
        .bearer_auth(SERVICE_SECRET)
        .json(&json!({
            "action_policy": "account-creation.light.v1",
            "action_reference": "action_persistence_01",
            "claimant_key": claimant_key
        }))
        .send()
        .await?;
    Ok(response.error_for_status()?.json().await?)
}

fn authority_config() -> Result<Config, Box<dyn Error>> {
    authority_config_with_signer_for_issuer("https://authority.example")
}

fn authority_config_without_signer() -> Result<Config, Box<dyn Error>> {
    authority_config_for_issuer("https://authority.example")
}

fn authority_config_for_issuer(issuer: &str) -> Result<Config, Box<dyn Error>> {
    let credential = ServiceCredential::new(
        CLIENT_ID,
        SERVICE_SECRET,
        DeploymentEnvironment::Development,
        "https://relying.example".to_owned(),
        vec!["https://app.relying.example".to_owned()],
        vec![ActionPolicy::AccountCreationLightV1],
    )?;
    let public = AuthorityPublicConfig::new(
        issuer,
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

fn authority_config_with_signer() -> Result<Config, Box<dyn Error>> {
    authority_config_with_signer_for_issuer("https://authority.example")
}

fn authority_config_with_signer_for_issuer(issuer: &str) -> Result<Config, Box<dyn Error>> {
    Ok(authority_config_for_issuer(issuer)?
        .with_signing_key_seed("authority-a".to_owned(), AUTHORITY_SIGNING_SEED)?)
}

fn light_target_event(session_id: WorkSessionId) -> Result<AcceptedWorkEvent, Box<dyn Error>> {
    light_target_event_with_id("event_persistence_01", "share_persistence_01", session_id)
}

async fn register_test_session(
    adapter: &SimulatedPoolAdapter,
    challenge_id: &ChallengeId,
    session_id: WorkSessionId,
) -> Result<(), Box<dyn Error>> {
    adapter
        .consent_default_pool_offer_for_simulation(challenge_id)
        .await?;
    adapter.register_session(challenge_id, session_id).await?;
    Ok(())
}

fn light_target_event_with_id(
    event_id: &str,
    share_fingerprint: &str,
    session_id: WorkSessionId,
) -> Result<AcceptedWorkEvent, Box<dyn Error>> {
    let mut target = [0xff_u8; 32];
    target[..5].fill(0);
    target[5] = 0x3f;
    Ok(AcceptedWorkEvent::try_from(AcceptedWorkEventInput {
        event_id: AcceptedWorkEventId::try_from(event_id.to_owned())?,
        work_session_id: session_id,
        assigned_target: target,
        received_at: ReceiptTime::try_from(
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),
        )?,
        share_fingerprint: ShareFingerprint::try_from(share_fingerprint.to_owned())?,
        network_target_outcome: NetworkTargetOutcome::BelowNetworkTarget,
        maybe_worker_report: None,
    })?)
}

fn difficulty_one_event(
    event_id: &str,
    share_fingerprint: &str,
    session_id: WorkSessionId,
) -> Result<AcceptedWorkEvent, Box<dyn Error>> {
    let mut target = [0_u8; 32];
    target[4] = 0xff;
    target[5] = 0xff;
    Ok(AcceptedWorkEvent::try_from(AcceptedWorkEventInput {
        event_id: AcceptedWorkEventId::try_from(event_id.to_owned())?,
        work_session_id: session_id,
        assigned_target: target,
        received_at: ReceiptTime::try_from(
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),
        )?,
        share_fingerprint: ShareFingerprint::try_from(share_fingerprint.to_owned())?,
        network_target_outcome: NetworkTargetOutcome::BelowNetworkTarget,
        maybe_worker_report: None,
    })?)
}

struct RunningServer {
    base_url: String,
    task: JoinHandle<()>,
}

impl RunningServer {
    async fn spawn(router: Router) -> Result<Self, Box<dyn Error>> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let task = tokio::spawn(async move {
            axum::serve(listener, router)
                .await
                .expect("test server should run until its task is stopped");
        });
        Ok(Self {
            base_url: format!("http://{address}"),
            task,
        })
    }

    fn stop(self) {
        self.task.abort();
    }
}
