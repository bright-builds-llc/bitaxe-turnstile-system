use std::time::{SystemTime, UNIX_EPOCH};

use axum::Router;
use bwg_core::{
    authority::{
        self, AuthorityApplication, AuthorityPublicConfig, CLAIMANT_PROOF_HEADER, CLIENT_ID_HEADER,
        Config as AuthorityConfig, DeploymentEnvironment, IssuanceWorkerId, ServiceCredential,
    },
    challenge::{ActionPolicy, ChallengeId},
    crypto_profile::{
        AuthorityKeySet, AuthoritySigningKey, GatePassClaimsInput, GatePassConfirmationInput,
    },
    progress::{
        AcceptedWorkEvent, AcceptedWorkEventId, AcceptedWorkEventInput, NetworkTargetOutcome,
        ReceiptTime, ShareFingerprint, WorkSessionId,
    },
    redemption::{RedemptionError, RedemptionRequest, RedemptionService},
    reference_service,
};
use serde_json::{Value, json};
use tokio::net::TcpListener;

#[path = "support/authority_keys.rs"]
mod authority_key_support;
#[path = "support/claimant.rs"]
mod claimant_support;
#[path = "support/postgres.rs"]
mod postgres_support;
use authority_key_support::authority_keys;
use claimant_support::Claimant;
use postgres_support::PostgresTestDatabase;

const CLIENT_ID: &str = "redemption-reference-service";
const SERVICE_SECRET: &str = "redemption-secret-P9vK2mQ7xR4tY8uN3cF6wL1zA5dH0sJ";
const RELYING_SERVICE_AUDIENCE: &str = "https://relying.example";
const AUTHORITY_SIGNING_SEED: &str = "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A";

#[tokio::test]
async fn complete_work_pass_redeem_journey_is_idempotent() -> Result<(), Box<dyn std::error::Error>>
{
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let adapter = application.simulated_pool_adapter();
    let authority_url = spawn_http(authority::router(application.clone())).await?;
    let (reference_url, redemption_url) = spawn_reference_service(authority_url.clone()).await?;
    let claimant = Claimant::generate()?;
    let challenge = reqwest::Client::new()
        .post(format!("{authority_url}/v0/challenges"))
        .header(CLIENT_ID_HEADER, CLIENT_ID)
        .bearer_auth(SERVICE_SECRET)
        .json(&json!({
            "action_policy": "account-creation.light.v1",
            "action_reference": "action_redemption_01",
            "claimant_key": claimant.public_jwk_json.clone()
        }))
        .send()
        .await?
        .json::<Value>()
        .await?;
    let challenge_id_text = challenge["challenge_id"]
        .as_str()
        .ok_or("challenge identifier is missing")?;
    let challenge_id = ChallengeId::try_from(challenge_id_text.to_owned())?;
    let session_id = WorkSessionId::try_from("session_redemption01".to_owned())?;
    adapter
        .register_session(&challenge_id, session_id.clone())
        .await?;

    // Act
    let acknowledgement = adapter.report(light_target_event(session_id)?).await?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    application
        .process_next_issuance(
            &IssuanceWorkerId::try_from("worker_redemption01".to_owned())?,
            now,
        )
        .await?;
    let public_lookup_url =
        format!("https://authority.example/v0/challenges/{challenge_id_text}/gate-pass");
    let request_lookup_url = format!("{authority_url}/v0/challenges/{challenge_id_text}/gate-pass");
    let issuance_proof = claimant.sign_issuance_proof(
        &public_lookup_url,
        challenge_id_text,
        "proof_redemption_lookup01",
        now,
    )?;
    let gate_pass = reqwest::Client::new()
        .get(&request_lookup_url)
        .header(CLAIMANT_PROOF_HEADER, issuance_proof)
        .send()
        .await?
        .json::<Value>()
        .await?["gate_pass"]
        .as_str()
        .ok_or("Gate Pass response is missing token")?
        .to_owned();
    let repeated_issuance_proof = claimant.sign_issuance_proof(
        &public_lookup_url,
        challenge_id_text,
        "proof_redemption_lookup02",
        now,
    )?;
    let repeated_gate_pass = reqwest::Client::new()
        .get(request_lookup_url)
        .header(CLAIMANT_PROOF_HEADER, repeated_issuance_proof)
        .send()
        .await?
        .json::<Value>()
        .await?["gate_pass"]
        .as_str()
        .ok_or("repeated Gate Pass response is missing token")?
        .to_owned();
    let first_proof = claimant.sign_dpop(&gate_pass, &redemption_url, "dpop_redemption01", now)?;
    let first_response = redeem(
        &reference_url,
        &gate_pass,
        &first_proof,
        "action_redemption_01",
    )
    .await?;
    let first_record = first_response.json::<Value>().await?;
    let retry_proof = claimant.sign_dpop(&gate_pass, &redemption_url, "dpop_redemption02", now)?;
    let retry_record = redeem(
        &reference_url,
        &gate_pass,
        &retry_proof,
        "action_redemption_01",
    )
    .await?
    .json::<Value>()
    .await?;
    let replay = redeem(
        &reference_url,
        &gate_pass,
        &first_proof,
        "action_redemption_01",
    )
    .await?;

    // Assert
    assert!(acknowledgement.issuance_intent_created());
    assert_eq!(gate_pass, repeated_gate_pass);
    assert_eq!(first_record, retry_record);
    assert!(first_record["account_id"].as_str().is_some());
    assert_eq!(replay.status(), reqwest::StatusCode::UNAUTHORIZED);

    Ok(())
}

#[test]
fn redemption_rejects_wrong_action_reference() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let claimant = Claimant::generate()?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let gate_pass = signed_gate_pass(
        &claimant,
        "https://authority.example",
        RELYING_SERVICE_AUDIENCE,
        "action_expected",
        now,
        now + 120,
    )?;

    // Act
    let result = redemption_service()?.redeem(
        redemption_request(
            &claimant,
            gate_pass,
            "action_wrong",
            "dpop_wrong_action",
            now,
        )?,
        now,
    );

    // Assert
    assert!(matches!(result, Err(RedemptionError::WrongActionReference)));

    Ok(())
}

#[test]
fn redemption_rejects_wrong_audience() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let claimant = Claimant::generate()?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let gate_pass = signed_gate_pass(
        &claimant,
        "https://authority.example",
        "https://wrong.example",
        "action_expected",
        now,
        now + 120,
    )?;

    // Act
    let result = redemption_service()?.redeem(
        redemption_request(
            &claimant,
            gate_pass,
            "action_expected",
            "dpop_wrong_audience",
            now,
        )?,
        now,
    );

    // Assert
    assert!(matches!(result, Err(RedemptionError::WrongAudience)));

    Ok(())
}

#[test]
fn redemption_rejects_wrong_authority_issuer() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let claimant = Claimant::generate()?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let gate_pass = signed_gate_pass(
        &claimant,
        "https://wrong-authority.example",
        RELYING_SERVICE_AUDIENCE,
        "action_expected",
        now,
        now + 120,
    )?;

    // Act
    let result = redemption_service()?.redeem(
        redemption_request(
            &claimant,
            gate_pass,
            "action_expected",
            "dpop_wrong_issuer",
            now,
        )?,
        now,
    );

    // Assert
    assert!(matches!(result, Err(RedemptionError::WrongIssuer)));

    Ok(())
}

#[test]
fn redemption_rejects_expired_gate_pass() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let claimant = Claimant::generate()?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let gate_pass = signed_gate_pass(
        &claimant,
        "https://authority.example",
        RELYING_SERVICE_AUDIENCE,
        "action_expected",
        now - 120,
        now - 1,
    )?;

    // Act
    let result = redemption_service()?.redeem(
        redemption_request(&claimant, gate_pass, "action_expected", "dpop_expired", now)?,
        now,
    );

    // Assert
    assert!(matches!(result, Err(RedemptionError::ExpiredGatePass)));

    Ok(())
}

#[test]
fn copied_gate_pass_rejects_wrong_claimant_key() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let claimant = Claimant::generate()?;
    let attacker = Claimant::generate()?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let gate_pass = signed_gate_pass(
        &claimant,
        "https://authority.example",
        RELYING_SERVICE_AUDIENCE,
        "action_expected",
        now,
        now + 120,
    )?;

    // Act
    let result = redemption_service()?.redeem(
        redemption_request(
            &attacker,
            gate_pass,
            "action_expected",
            "dpop_attacker",
            now,
        )?,
        now,
    );

    // Assert
    assert!(matches!(result, Err(RedemptionError::WrongClaimantKey)));

    Ok(())
}

#[test]
fn redemption_rejects_stale_or_wrong_uri_dpop() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let claimant = Claimant::generate()?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let gate_pass = signed_gate_pass(
        &claimant,
        "https://authority.example",
        RELYING_SERVICE_AUDIENCE,
        "action_expected",
        now,
        now + 120,
    )?;
    let stale_request = redemption_request(
        &claimant,
        gate_pass.clone(),
        "action_expected",
        "dpop_stale",
        now - 61,
    )?;
    let wrong_uri_proof = claimant.sign_dpop(
        &gate_pass,
        "http://127.0.0.1:1/wrong",
        "dpop_wrong_uri",
        now,
    )?;

    // Act
    let stale = redemption_service()?.redeem(stale_request, now);
    let wrong_uri = redemption_service()?.redeem(
        RedemptionRequest {
            gate_pass,
            dpop_proof: wrong_uri_proof,
            action_reference: "action_expected".to_owned(),
        },
        now,
    );

    // Assert
    assert!(matches!(stale, Err(RedemptionError::StaleDpopProof)));
    assert!(matches!(wrong_uri, Err(RedemptionError::WrongDpopRequest)));

    Ok(())
}

#[tokio::test]
async fn concurrent_redemption_creates_one_stable_record() -> Result<(), Box<dyn std::error::Error>>
{
    // Arrange
    let claimant = Claimant::generate()?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let gate_pass = signed_gate_pass(
        &claimant,
        "https://authority.example",
        RELYING_SERVICE_AUDIENCE,
        "action_expected",
        now,
        now + 120,
    )?;
    let first_request = redemption_request(
        &claimant,
        gate_pass.clone(),
        "action_expected",
        "dpop_concurrent01",
        now,
    )?;
    let second_request = redemption_request(
        &claimant,
        gate_pass,
        "action_expected",
        "dpop_concurrent02",
        now,
    )?;
    let service = redemption_service()?;

    // Act
    let first_service = service.clone();
    let first = tokio::spawn(async move { first_service.redeem(first_request, now) });
    let second = tokio::spawn(async move { service.redeem(second_request, now) });
    let first_record = first.await??;
    let second_record = second.await??;

    // Assert
    assert_eq!(first_record, second_record);

    Ok(())
}

fn signed_gate_pass(
    claimant: &Claimant,
    issuer: &str,
    audience: &str,
    action_reference: &str,
    issued_at: u64,
    expires_at: u64,
) -> Result<String, Box<dyn std::error::Error>> {
    Ok(authority_signer()?.sign_gate_pass(&GatePassClaimsInput {
        iss: issuer.to_owned(),
        aud: audience.to_owned(),
        iat: issued_at,
        exp: expires_at,
        jti: format!("pass_test_{issued_at}_{expires_at}"),
        challenge_id: "challenge_testpass01".to_owned(),
        protected_action_type: "account_creation".to_owned(),
        action_reference: action_reference.to_owned(),
        action_policy: "account-creation.light.v1".to_owned(),
        cnf: GatePassConfirmationInput {
            jkt: claimant.jkt()?,
        },
        bwg_version: "BWG/0.1".to_owned(),
    })?)
}

fn authority_signer() -> Result<AuthoritySigningKey, Box<dyn std::error::Error>> {
    let keys = AuthorityKeySet::try_from(authority_keys()?)?;
    Ok(AuthoritySigningKey::from_seed_base64url(
        "authority-a".to_owned(),
        AUTHORITY_SIGNING_SEED,
        &keys,
    )?)
}

fn redemption_service() -> Result<RedemptionService, Box<dyn std::error::Error>> {
    let keys = AuthorityKeySet::try_from(authority_keys()?)?;
    Ok(RedemptionService::new(
        "https://authority.example".to_owned(),
        keys.keys().to_vec(),
        RELYING_SERVICE_AUDIENCE.to_owned(),
        "http://127.0.0.1:1/account-creation/redeem".to_owned(),
    ))
}

fn redemption_request(
    claimant: &Claimant,
    gate_pass: String,
    action_reference: &str,
    proof_id: &str,
    issued_at: u64,
) -> Result<RedemptionRequest, Box<dyn std::error::Error>> {
    let dpop_proof = claimant.sign_dpop(
        &gate_pass,
        "http://127.0.0.1:1/account-creation/redeem",
        proof_id,
        issued_at,
    )?;
    Ok(RedemptionRequest {
        gate_pass,
        dpop_proof,
        action_reference: action_reference.to_owned(),
    })
}

fn authority_config() -> Result<AuthorityConfig, Box<dyn std::error::Error>> {
    let keys = authority_keys()?;
    let credential = ServiceCredential::new(
        CLIENT_ID,
        SERVICE_SECRET,
        DeploymentEnvironment::Development,
        RELYING_SERVICE_AUDIENCE.to_owned(),
        vec!["https://app.relying.example".to_owned()],
        vec![ActionPolicy::AccountCreationLightV1],
    )?;
    let public = AuthorityPublicConfig::new(
        "https://authority.example",
        "https://authority.example",
        keys,
        "https://authority.example/policies/operator",
        "https://authority.example/privacy",
        "https://authority.example/terms",
    )?;
    Ok(
        AuthorityConfig::new(DeploymentEnvironment::Development, vec![credential], public)?
            .with_signing_key_seed("authority-a".to_owned(), AUTHORITY_SIGNING_SEED)?,
    )
}

async fn spawn_reference_service(
    authority_url: String,
) -> Result<(String, String), Box<dyn std::error::Error>> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let reference_url = format!("http://{address}");
    let redemption_url = format!("{reference_url}/account-creation/redeem");
    let trusted =
        reference_service::TrustedAuthority::new("https://authority.example", authority_keys()?)?;
    let config = reference_service::Config::new(
        authority_url,
        CLIENT_ID,
        SERVICE_SECRET,
        RELYING_SERVICE_AUDIENCE,
        redemption_url.clone(),
        trusted,
    )?;
    let router = reference_service::router(config);
    tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("test reference service should remain available");
    });
    Ok((reference_url, redemption_url))
}

fn light_target_event(
    session_id: WorkSessionId,
) -> Result<AcceptedWorkEvent, Box<dyn std::error::Error>> {
    let mut target = [0xff_u8; 32];
    target[..5].fill(0);
    target[5] = 0x3f;
    Ok(AcceptedWorkEvent::try_from(AcceptedWorkEventInput {
        event_id: AcceptedWorkEventId::try_from("event_redemption01".to_owned())?,
        work_session_id: session_id,
        assigned_target: target,
        received_at: ReceiptTime::try_from(
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),
        )?,
        share_fingerprint: ShareFingerprint::try_from("share_redemption01".to_owned())?,
        network_target_outcome: NetworkTargetOutcome::BelowNetworkTarget,
        maybe_worker_report: None,
    })?)
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

async fn spawn_http(router: Router) -> Result<String, std::io::Error> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("test server should remain available");
    });
    Ok(format!("http://{address}"))
}
