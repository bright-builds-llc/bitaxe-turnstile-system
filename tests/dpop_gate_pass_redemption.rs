use std::{
    io::Error,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::Router;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use bwg_core::{
    authority::{
        self, AuthorityPublicConfig, CLIENT_ID_HEADER, Config as AuthorityConfig,
        DeploymentEnvironment, ServiceCredential,
    },
    challenge::{ActionPolicy, ChallengeId},
    crypto_profile::{
        AuthorityKeySet, AuthoritySigningKey, GatePassClaimsInput, GatePassConfirmationInput,
        P256PublicJwk, P256PublicJwkWire, access_token_hash, p256_jwk_thumbprint,
    },
    progress::{
        AcceptedWorkEvent, AcceptedWorkEventId, AcceptedWorkEventInput, NetworkTargetOutcome,
        ReceiptTime, ShareFingerprint, WorkSessionId,
    },
    redemption::{RedemptionError, RedemptionRequest, RedemptionService},
    reference_service,
};
use ring::{
    rand::SystemRandom,
    signature::{self, KeyPair as _},
};
use serde_json::{Value, json};
use tokio::net::TcpListener;

#[path = "support/authority_keys.rs"]
mod authority_key_support;
use authority_key_support::authority_keys;

const CLIENT_ID: &str = "redemption-reference-service";
const SERVICE_SECRET: &str = "redemption-secret-P9vK2mQ7xR4tY8uN3cF6wL1zA5dH0sJ";
const RELYING_SERVICE_AUDIENCE: &str = "https://relying.example";
const AUTHORITY_SIGNING_SEED: &str = "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A";

#[tokio::test]
async fn complete_work_pass_redeem_journey_is_idempotent() -> Result<(), Box<dyn std::error::Error>>
{
    // Arrange
    let authority_config = authority_config()?;
    let adapter = authority_config.simulated_pool_adapter();
    let authority_url = spawn_http(authority::router(authority_config)).await?;
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
    adapter.register_session(&challenge_id, session_id.clone())?;

    // Act
    let acknowledgement = adapter.report(light_target_event(session_id)?)?;
    let gate_pass = reqwest::get(format!(
        "{authority_url}/v0/challenges/{challenge_id_text}/gate-pass"
    ))
    .await?
    .json::<Value>()
    .await?["gate_pass"]
        .as_str()
        .ok_or("Gate Pass response is missing token")?
        .to_owned();
    let repeated_gate_pass = reqwest::get(format!(
        "{authority_url}/v0/challenges/{challenge_id_text}/gate-pass"
    ))
    .await?
    .json::<Value>()
    .await?["gate_pass"]
        .as_str()
        .ok_or("repeated Gate Pass response is missing token")?
        .to_owned();
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
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

struct Claimant {
    key_pair: Arc<signature::EcdsaKeyPair>,
    public_jwk: Value,
    public_jwk_json: String,
}

impl Claimant {
    fn generate() -> Result<Self, Box<dyn std::error::Error>> {
        let rng = SystemRandom::new();
        let pkcs8 = signature::EcdsaKeyPair::generate_pkcs8(
            &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
            &rng,
        )
        .map_err(|_| Error::other("failed to generate P-256 test key"))?;
        let key_pair = signature::EcdsaKeyPair::from_pkcs8(
            &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
            pkcs8.as_ref(),
            &rng,
        )
        .map_err(|error| Error::other(format!("failed to import P-256 test key: {error}")))?;
        let public_key = key_pair.public_key().as_ref();
        if public_key.len() != 65 || public_key[0] != 0x04 {
            return Err("P-256 public key is not uncompressed SEC1".into());
        }
        let public_jwk = json!({
            "kty": "EC",
            "crv": "P-256",
            "x": URL_SAFE_NO_PAD.encode(&public_key[1..33]),
            "y": URL_SAFE_NO_PAD.encode(&public_key[33..65]),
            "alg": "ES256"
        });
        Ok(Self {
            key_pair: Arc::new(key_pair),
            public_jwk_json: serde_json::to_string(&public_jwk)?,
            public_jwk,
        })
    }

    fn jkt(&self) -> Result<String, Box<dyn std::error::Error>> {
        let wire = serde_json::from_value::<P256PublicJwkWire>(self.public_jwk.clone())?;
        let key = P256PublicJwk::try_from(wire)?;
        Ok(p256_jwk_thumbprint(&key))
    }

    fn sign_dpop(
        &self,
        gate_pass: &str,
        redemption_url: &str,
        proof_id: &str,
        issued_at: u64,
    ) -> Result<String, Box<dyn std::error::Error>> {
        let header = json!({
            "typ": "dpop+jwt",
            "alg": "ES256",
            "jwk": self.public_jwk
        });
        let payload = json!({
            "jti": proof_id,
            "htm": "POST",
            "htu": redemption_url,
            "iat": issued_at,
            "ath": access_token_hash(gate_pass)
        });
        let protected = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header)?);
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload)?);
        let signing_input = format!("{protected}.{payload}");
        let signature = self
            .key_pair
            .sign(&SystemRandom::new(), signing_input.as_bytes())
            .map_err(|_| Error::other("failed to sign DPoP proof"))?;
        Ok(format!(
            "{signing_input}.{}",
            URL_SAFE_NO_PAD.encode(signature.as_ref())
        ))
    }
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
        action_reference: action_reference.to_owned(),
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
