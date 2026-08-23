use std::{
    error::Error,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use bwg_core::{
    authority::{
        self, AuthorityApplication, AuthorityPublicConfig, DeploymentEnvironment, ServiceCredential,
    },
    challenge::ActionPolicy,
    crypto_profile::{
        AuthorityKeySet, AuthoritySigningKey, GatePassClaimsInput, GatePassConfirmationInput,
    },
    reference_service::{
        self, ActionProcessingOutcome, ActionWorkerId, CLAIMANT_PROOF_HEADER, ReferenceApplication,
        ReferenceApplicationError, TrustedAuthority,
    },
};
use serde_json::{Value, json};
use tokio::{net::TcpListener, task::JoinHandle};

#[path = "support/authority_keys.rs"]
mod authority_key_support;
#[path = "support/claimant.rs"]
mod claimant_support;
#[path = "relying_service_persistence/governance.rs"]
mod governance;
#[path = "support/http.rs"]
mod http_support;
#[path = "support/postgres.rs"]
mod postgres_support;

use authority_key_support::authority_keys;
use claimant_support::Claimant;
use http_support::{send_get_without_reading_response, send_json_post_without_reading_response};
use postgres_support::PostgresTestDatabase;

const CLIENT_ID: &str = "persistent-reference-service";
const SERVICE_SECRET: &str = "persistent-secret-P9vK2mQ7xR4tY8uN3cF6wL1zA5dH0sJ";
const AUTHORITY_SIGNING_SEED: &str = "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A";
const AUTHORITY_ISSUER: &str = "https://authority.example";
const RELYING_SERVICE_AUDIENCE: &str = "https://relying.example";

#[tokio::test]
async fn action_reference_rejects_a_different_claimant_key() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let authority =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let authority_server = RunningServer::spawn(authority::router(authority)).await?;
    let reference_listener = TcpListener::bind("127.0.0.1:0").await?;
    let reference_address = reference_listener.local_addr()?;
    let reference_url = format!("http://{reference_address}");
    let redemption_url = format!("{reference_url}/account-creation/redeem");
    let reference = ReferenceApplication::connect_postgres(
        reference_config(authority_server.base_url.clone(), redemption_url.clone())?,
        database.database_url(),
    )
    .await?;
    let _reference_task =
        spawn_on_listener(reference_listener, reference_service::router(reference));
    let original_claimant = Claimant::generate()?;
    let challenge = reqwest::Client::new()
        .post(format!("{reference_url}/account-creation/challenge"))
        .json(&json!({ "claimant_key": original_claimant.public_jwk_json }))
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    let action_reference = challenge["action_reference"]
        .as_str()
        .ok_or("challenge needs an Action Reference")?;
    let other_claimant = Claimant::generate()?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let gate_pass = signed_gate_pass(
        &other_claimant,
        action_reference,
        "pass_wrong_action_claimant_01",
        now,
    )?;
    let dpop = other_claimant.sign_dpop(
        &gate_pass,
        &redemption_url,
        "dpop_wrong_action_claimant_01",
        now,
    )?;

    // Act
    let response = reqwest::Client::new()
        .post(redemption_url)
        .json(&json!({
            "gate_pass": gate_pass,
            "dpop_proof": dpop,
            "action_reference": action_reference
        }))
        .send()
        .await?;

    // Assert
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);

    Ok(())
}

#[tokio::test]
async fn restart_rejects_consumed_pass_and_converges_new_pass_on_one_redemption()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let authority =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let authority_server = RunningServer::spawn(authority::router(authority)).await?;
    let claimant = Claimant::generate()?;
    let (first_reference, first_redemption_url) =
        spawn_reference(&authority_server.base_url, database.database_url()).await?;
    let challenge = reqwest::Client::new()
        .post(format!(
            "{}/account-creation/challenge",
            first_reference.base_url
        ))
        .json(&json!({ "claimant_key": claimant.public_jwk_json }))
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    let action_reference = challenge["action_reference"]
        .as_str()
        .ok_or("challenge needs an Action Reference")?
        .to_owned();
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let first_pass = signed_gate_pass(&claimant, &action_reference, "pass_durable_01", now)?;
    let first_dpop =
        claimant.sign_dpop(&first_pass, &first_redemption_url, "dpop_durable_01", now)?;
    let lost_response_stream = send_json_post_without_reading_response(
        &first_redemption_url,
        &json!({
            "gate_pass": first_pass,
            "dpop_proof": first_dpop,
            "action_reference": action_reference
        }),
    )?;
    tokio::time::sleep(Duration::from_millis(50)).await;
    drop(lost_response_stream);
    first_reference.stop();

    // Act
    let (restarted_reference, restarted_redemption_url) =
        spawn_reference(&authority_server.base_url, database.database_url()).await?;
    let replay_dpop = claimant.sign_dpop(
        &first_pass,
        &restarted_redemption_url,
        "dpop_durable_replay_01",
        now,
    )?;
    let consumed_replay = redeem(
        &restarted_reference.base_url,
        &first_pass,
        &replay_dpop,
        &action_reference,
    )
    .await?;
    let second_pass = signed_gate_pass(&claimant, &action_reference, "pass_durable_02", now)?;
    let second_dpop = claimant.sign_dpop(
        &second_pass,
        &restarted_redemption_url,
        "dpop_durable_02",
        now,
    )?;
    let converged_record = redeem(
        &restarted_reference.base_url,
        &second_pass,
        &second_dpop,
        &action_reference,
    )
    .await?
    .error_for_status()?
    .json::<Value>()
    .await?;

    // Assert
    assert_eq!(consumed_replay.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert_eq!(converged_record["outcome"]["status"], "pending");

    Ok(())
}

#[tokio::test]
async fn expired_action_lease_recovers_one_immutable_success() -> Result<(), Box<dyn Error>> {
    // Arrange
    let pending = create_pending_redemption().await?;
    let unavailable_worker = ReferenceApplication::connect_postgres(
        pending.config.clone(),
        pending.database.database_url(),
    )
    .await?;
    let first_worker = ActionWorkerId::try_from("action_worker_first_01".to_owned())?;
    let unavailable = unavailable_worker
        .process_next_action(&first_worker, pending.accepted_at)
        .await;
    assert!(matches!(
        unavailable,
        Err(ReferenceApplicationError::ExecutionUnavailable)
    ));

    // Act
    let replacement = ReferenceApplication::connect_postgres(
        pending.config.with_account_creation_executor(),
        pending.database.database_url(),
    )
    .await?;
    let replacement_worker = ActionWorkerId::try_from("action_worker_replacement_01".to_owned())?;
    let before_expiry = replacement
        .process_next_action(&replacement_worker, pending.accepted_at + 1)
        .await?;
    let recovered = replacement
        .process_next_action(&replacement_worker, pending.accepted_at + 31)
        .await?;
    let repeated = replacement
        .process_next_action(&replacement_worker, pending.accepted_at + 32)
        .await?;

    // Assert
    assert_eq!(before_expiry, ActionProcessingOutcome::NoWork);
    assert!(matches!(
        recovered,
        ActionProcessingOutcome::Succeeded { ref redemption_id }
            if redemption_id == &pending.redemption_id
    ));
    assert_eq!(repeated, ActionProcessingOutcome::NoWork);

    Ok(())
}

#[tokio::test]
async fn outcome_lookup_returns_durable_success_without_reexecution() -> Result<(), Box<dyn Error>>
{
    // Arrange
    let pending = create_pending_redemption().await?;
    let executor = ReferenceApplication::connect_postgres(
        pending.config.clone().with_account_creation_executor(),
        pending.database.database_url(),
    )
    .await?;
    executor
        .process_next_action(
            &ActionWorkerId::try_from("action_worker_outcome_lookup_01".to_owned())?,
            pending.accepted_at,
        )
        .await?;
    let lookup_url = format!(
        "{}/account-creation/outcomes/{}",
        pending.reference_url, pending.action_reference
    );
    let proof = pending.claimant.sign_outcome_proof(
        &lookup_url,
        &pending.action_reference,
        "proof_outcome_lookup_01",
        pending.accepted_at,
    )?;
    let wrong_claimant = Claimant::generate()?;
    let wrong_key_proof = wrong_claimant.sign_outcome_proof(
        &lookup_url,
        &pending.action_reference,
        "proof_outcome_wrong_key_01",
        pending.accepted_at,
    )?;
    let wrong_key = reqwest::Client::new()
        .get(&lookup_url)
        .header(CLAIMANT_PROOF_HEADER, wrong_key_proof)
        .send()
        .await?;
    let wrong_key_status = wrong_key.status();
    let wrong_key_body = wrong_key.json::<Value>().await?;
    let unknown_reference = "action_unknown_outcome_01";
    let unknown_url = format!(
        "{}/account-creation/outcomes/{unknown_reference}",
        pending.reference_url
    );
    let unknown_proof = pending.claimant.sign_outcome_proof(
        &unknown_url,
        unknown_reference,
        "proof_outcome_unknown_01",
        pending.accepted_at,
    )?;
    let unknown = reqwest::Client::new()
        .get(unknown_url)
        .header(CLAIMANT_PROOF_HEADER, unknown_proof)
        .send()
        .await?;
    let unknown_status = unknown.status();
    let unknown_body = unknown.json::<Value>().await?;

    // Act
    let lost_response_stream =
        send_get_without_reading_response(&lookup_url, CLAIMANT_PROOF_HEADER, &proof)?;
    tokio::time::sleep(Duration::from_millis(50)).await;
    drop(lost_response_stream);
    let replay = reqwest::Client::new()
        .get(&lookup_url)
        .header(CLAIMANT_PROOF_HEADER, proof)
        .send()
        .await?;
    let retry_proof = pending.claimant.sign_outcome_proof(
        &lookup_url,
        &pending.action_reference,
        "proof_outcome_lookup_02",
        pending.accepted_at,
    )?;
    let retry_body = reqwest::Client::new()
        .get(&lookup_url)
        .header(CLAIMANT_PROOF_HEADER, retry_proof)
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    let repeated_proof = pending.claimant.sign_outcome_proof(
        &lookup_url,
        &pending.action_reference,
        "proof_outcome_lookup_03",
        pending.accepted_at,
    )?;
    let repeated_body = reqwest::Client::new()
        .get(&lookup_url)
        .header(CLAIMANT_PROOF_HEADER, repeated_proof)
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;

    // Assert
    assert_eq!(wrong_key_status, reqwest::StatusCode::NOT_FOUND);
    assert_eq!(unknown_status, reqwest::StatusCode::NOT_FOUND);
    assert_eq!(wrong_key_body, unknown_body);
    assert_eq!(replay.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert_eq!(retry_body, repeated_body);
    assert_eq!(retry_body["outcome"]["status"], "succeeded");
    assert!(
        retry_body["outcome"]["result"]["account_id"]
            .as_str()
            .is_some()
    );
    assert_eq!(
        executor
            .process_next_action(
                &ActionWorkerId::try_from("action_worker_outcome_retry_01".to_owned())?,
                pending.accepted_at + 1,
            )
            .await?,
        ActionProcessingOutcome::NoWork
    );

    Ok(())
}

#[tokio::test]
async fn exhausted_action_attempts_create_one_immutable_failure() -> Result<(), Box<dyn Error>> {
    // Arrange
    let pending = create_pending_redemption().await?;
    let unavailable = ReferenceApplication::connect_postgres(
        pending.config.clone(),
        pending.database.database_url(),
    )
    .await?;
    let worker = ActionWorkerId::try_from("action_worker_exhaustion_01".to_owned())?;

    // Act
    for offset in [0, 31, 62] {
        assert!(matches!(
            unavailable
                .process_next_action(&worker, pending.accepted_at + offset)
                .await,
            Err(ReferenceApplicationError::ExecutionUnavailable)
        ));
    }
    let exhausted = unavailable
        .process_next_action(&worker, pending.accepted_at + 93)
        .await?;
    let lookup_url = format!(
        "{}/account-creation/outcomes/{}",
        pending.reference_url, pending.action_reference
    );
    let proof = pending.claimant.sign_outcome_proof(
        &lookup_url,
        &pending.action_reference,
        "proof_outcome_exhausted_01",
        pending.accepted_at,
    )?;
    let outcome = reqwest::Client::new()
        .get(lookup_url)
        .header(CLAIMANT_PROOF_HEADER, proof)
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    let enabled = ReferenceApplication::connect_postgres(
        pending.config.with_account_creation_executor(),
        pending.database.database_url(),
    )
    .await?;
    let after_failure = enabled
        .process_next_action(&worker, pending.accepted_at + 94)
        .await?;

    // Assert
    assert_eq!(exhausted, ActionProcessingOutcome::NoWork);
    assert_eq!(outcome["outcome"]["status"], "failed");
    assert_eq!(outcome["outcome"]["reason"], "action_execution_exhausted");
    assert_eq!(after_failure, ActionProcessingOutcome::NoWork);

    Ok(())
}

struct PendingRedemption {
    database: PostgresTestDatabase,
    config: reference_service::Config,
    redemption_id: String,
    accepted_at: u64,
    reference_url: String,
    action_reference: String,
    claimant: Claimant,
}

async fn create_pending_redemption() -> Result<PendingRedemption, Box<dyn Error>> {
    let database = PostgresTestDatabase::start().await?;
    let authority =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let authority_server = RunningServer::spawn(authority::router(authority)).await?;
    let claimant = Claimant::generate()?;
    let (reference_server, redemption_url) =
        spawn_reference(&authority_server.base_url, database.database_url()).await?;
    let config = reference_config(authority_server.base_url.clone(), redemption_url.clone())?;
    let challenge = reqwest::Client::new()
        .post(format!(
            "{}/account-creation/challenge",
            reference_server.base_url
        ))
        .json(&json!({ "claimant_key": claimant.public_jwk_json }))
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    let action_reference = challenge["action_reference"]
        .as_str()
        .ok_or("challenge needs an Action Reference")?;
    let accepted_at = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let gate_pass = signed_gate_pass(
        &claimant,
        action_reference,
        "pass_pending_execution_01",
        accepted_at,
    )?;
    let dpop = claimant.sign_dpop(
        &gate_pass,
        &redemption_url,
        "dpop_pending_execution_01",
        accepted_at,
    )?;
    let record = redeem(
        &reference_server.base_url,
        &gate_pass,
        &dpop,
        action_reference,
    )
    .await?
    .error_for_status()?
    .json::<Value>()
    .await?;
    Ok(PendingRedemption {
        database,
        config,
        redemption_id: record["redemption_id"]
            .as_str()
            .ok_or("Redemption response needs an identifier")?
            .to_owned(),
        accepted_at,
        reference_url: reference_server.base_url,
        action_reference: action_reference.to_owned(),
        claimant,
    })
}

fn authority_config() -> Result<authority::Config, Box<dyn Error>> {
    let credential = ServiceCredential::new(
        CLIENT_ID,
        SERVICE_SECRET,
        DeploymentEnvironment::Development,
        RELYING_SERVICE_AUDIENCE.to_owned(),
        vec!["https://app.relying.example".to_owned()],
        vec![ActionPolicy::AccountCreationStandardV1],
    )?;
    let public = AuthorityPublicConfig::new(
        AUTHORITY_ISSUER,
        AUTHORITY_ISSUER,
        authority_keys()?,
        "https://authority.example/policies/operator",
        "https://authority.example/privacy",
        "https://authority.example/terms",
    )?;
    Ok(authority::Config::new(
        DeploymentEnvironment::Development,
        vec![credential],
        public,
    )?)
}

fn reference_config(
    authority_url: String,
    redemption_url: String,
) -> Result<reference_service::Config, Box<dyn Error>> {
    Ok(reference_service::Config::new(
        authority_url,
        CLIENT_ID,
        SERVICE_SECRET,
        RELYING_SERVICE_AUDIENCE,
        redemption_url,
        TrustedAuthority::new(AUTHORITY_ISSUER, authority_keys()?)?,
    )?)
}

fn signed_gate_pass(
    claimant: &Claimant,
    action_reference: &str,
    pass_id: &str,
    now: u64,
) -> Result<String, Box<dyn Error>> {
    let keys = AuthorityKeySet::try_from(authority_keys()?)?;
    let signer = AuthoritySigningKey::from_seed_base64url(
        "authority-a".to_owned(),
        AUTHORITY_SIGNING_SEED,
        &keys,
    )?;
    Ok(signer.sign_gate_pass(&GatePassClaimsInput {
        iss: AUTHORITY_ISSUER.to_owned(),
        aud: RELYING_SERVICE_AUDIENCE.to_owned(),
        iat: now,
        exp: now + 120,
        jti: pass_id.to_owned(),
        challenge_id: "challenge_wrong_action_claimant_01".to_owned(),
        protected_action_type: "account_creation".to_owned(),
        action_reference: action_reference.to_owned(),
        action_policy: "account-creation.standard.v1".to_owned(),
        cnf: GatePassConfirmationInput {
            jkt: claimant.jkt()?,
        },
        bwg_version: "BWG/0.1".to_owned(),
    })?)
}

struct RunningServer {
    base_url: String,
    _task: JoinHandle<()>,
}

impl RunningServer {
    async fn spawn(router: axum::Router) -> Result<Self, Box<dyn Error>> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let task = spawn_on_listener(listener, router);
        Ok(Self {
            base_url: format!("http://{address}"),
            _task: task,
        })
    }

    fn stop(self) {
        self._task.abort();
    }
}

async fn spawn_reference(
    authority_url: &str,
    database_url: &str,
) -> Result<(RunningServer, String), Box<dyn Error>> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let base_url = format!("http://{address}");
    let redemption_url = format!("{base_url}/account-creation/redeem");
    let config = reference_config(authority_url.to_owned(), redemption_url.clone())?;
    let application = ReferenceApplication::connect_postgres(config, database_url).await?;
    let task = spawn_on_listener(listener, reference_service::router(application));
    Ok((
        RunningServer {
            base_url,
            _task: task,
        },
        redemption_url,
    ))
}

async fn redeem(
    reference_url: &str,
    gate_pass: &str,
    dpop_proof: &str,
    action_reference: &str,
) -> Result<reqwest::Response, reqwest::Error> {
    reqwest::Client::new()
        .post(format!("{reference_url}/account-creation/redeem"))
        .json(&json!({
            "gate_pass": gate_pass,
            "dpop_proof": dpop_proof,
            "action_reference": action_reference
        }))
        .send()
        .await
}

fn spawn_on_listener(listener: TcpListener, router: axum::Router) -> JoinHandle<()> {
    tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("test server should remain available");
    })
}
