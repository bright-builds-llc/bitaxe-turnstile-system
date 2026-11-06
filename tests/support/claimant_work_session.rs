//! Shared claimant Work Session fixture for the ADR-0106 and ADR-0107 route tests.
#![allow(dead_code)]

use std::{
    error::Error,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use bwg_core::{
    authority::{
        self, AuthorityApplication, AuthorityPublicConfig, CLIENT_ID_HEADER, Config,
        DeploymentEnvironment, ServiceCredential, WorkerLeaseIssuance, WorkerStratumCredentialPort,
    },
    challenge::{ActionPolicy, ChallengeId},
    stratum_v1::{
        PoolAdapterWorkerStratum, PostgresStratumSessionRegistry, StratumCredentialIssuer,
    },
    work_lease_authorization::WorkLeaseAuthoritySigner,
};
use ring::signature;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    authority_key_support::authority_keys, claimant_support::Claimant,
    postgres_support::PostgresTestDatabase, running_server::RunningServer,
};

pub(crate) const CLIENT_ID: &str = "work-session-reference-service";
pub(crate) const SERVICE_SECRET: &str = "work-session-secret-P9vK2mQ7xR4tY8uN3cF6wL1zA5dH0s";
pub(crate) const AUTHORITY_SIGNING_SEED: &str = "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A";
pub(crate) const PUBLIC_BASE_URL: &str = "https://authority.example";
pub(crate) const STRATUM_ENDPOINT: &str = "stratum+tcp://pool-adapter.test:3333/";
pub(crate) const CONTROL_SESSION: &str = "jEc1ro90lL2fX0ZozUbY0XpmxrC46gEkEUKKTyGj0Zs";
pub(crate) const OTHER_CONTROL_SESSION: &str = "Zm9yZWlnbi1jb250cm9sLXNlc3Npb24tZGlnZXN0MDE";

pub(crate) struct Fixture {
    pub(crate) database: PostgresTestDatabase,
    pub(crate) application: AuthorityApplication,
    pub(crate) server: RunningServer,
    pub(crate) claimant: Claimant,
    pub(crate) challenge_id: ChallengeId,
}

impl Fixture {
    /// Starts with the default Pool Offer consented through the simulated adapter.
    pub(crate) async fn start() -> Result<Self, Box<dyn Error>> {
        let fixture = Self::start_unselected().await?;
        fixture
            .application
            .simulated_pool_adapter()
            .consent_default_pool_offer_for_simulation(&fixture.challenge_id)
            .await?;
        Ok(fixture)
    }

    /// Starts with a challenge whose claimant hasn't selected a pool.
    pub(crate) async fn start_unselected() -> Result<Self, Box<dyn Error>> {
        let database = PostgresTestDatabase::start().await?;
        let application = leased_application(&database).await?;
        let server = RunningServer::spawn(authority::router(application.clone())).await?;
        let claimant = Claimant::generate()?;
        let challenge_id = create_challenge(&server.base_url, &claimant).await?;
        Ok(Self {
            database,
            application,
            server,
            claimant,
            challenge_id,
        })
    }

    pub(crate) async fn post(
        &self,
        operation: &str,
        body: &Value,
    ) -> Result<reqwest::Response, Box<dyn Error>> {
        let body = serde_json::to_vec(body)?;
        let proof = self.proof(operation, &body)?;
        self.send(operation, body, &proof).await
    }

    pub(crate) fn proof(&self, operation: &str, body: &[u8]) -> Result<String, Box<dyn Error>> {
        self.claimant.sign_work_session_proof(
            &format!(
                "{PUBLIC_BASE_URL}/v0/challenges/{}/work-session/{operation}",
                self.challenge_id.as_str()
            ),
            self.challenge_id.as_str(),
            &format!("proof_{}", Uuid::new_v4().simple()),
            now()?,
            body,
        )
    }

    pub(crate) async fn send(
        &self,
        operation: &str,
        body: Vec<u8>,
        proof: &str,
    ) -> Result<reqwest::Response, Box<dyn Error>> {
        Ok(reqwest::Client::new()
            .post(format!(
                "{}/v0/challenges/{}/work-session/{operation}",
                self.server.base_url,
                self.challenge_id.as_str()
            ))
            .header("content-type", "application/json")
            .header(authority::CLAIMANT_PROOF_HEADER, proof)
            .body(body)
            .send()
            .await?)
    }

    pub(crate) async fn start_work(&self) -> Result<Value, Box<dyn Error>> {
        let response = self
            .post(
                "start",
                &json!({ "control_session_binding_sha256": CONTROL_SESSION }),
            )
            .await?;
        Ok(response.error_for_status()?.json().await?)
    }

    pub(crate) async fn renew(
        &self,
        lease_id: &Value,
        control: &str,
    ) -> Result<reqwest::Response, Box<dyn Error>> {
        self.post(
            "renew",
            &json!({ "control_session_binding_sha256": control, "lease_id": lease_id }),
        )
        .await
    }

    pub(crate) async fn pause(&self) -> Result<(), Box<dyn Error>> {
        self.post("pause", &json!({ "reason": "user_requested" }))
            .await?
            .error_for_status()?;
        Ok(())
    }
}

pub(crate) fn now() -> Result<u64, Box<dyn Error>> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs())
}

pub(crate) fn test_lease_signer() -> Result<WorkLeaseAuthoritySigner, Box<dyn Error>> {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../conformance/bwg-worker-deployment-trust-0.2/authority-signer-vectors.json"
    ))?;
    Ok(WorkLeaseAuthoritySigner::from_seed_base64url(
        "test-work-lease-authority".to_owned(),
        "test-work-lease-authority".to_owned(),
        vectors["seedBase64Url"].as_str().ok_or("vector seed")?,
    )?)
}

pub(crate) fn authority_config() -> Result<Config, Box<dyn Error>> {
    let credential = ServiceCredential::new(
        CLIENT_ID,
        SERVICE_SECRET,
        DeploymentEnvironment::Development,
        "https://relying.example".to_owned(),
        vec!["https://app.relying.example".to_owned()],
        vec![ActionPolicy::AccountCreationLightV1],
    )?;
    let public = AuthorityPublicConfig::new(
        PUBLIC_BASE_URL,
        PUBLIC_BASE_URL,
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

pub(crate) async fn pool_adapter_stratum(
    database: &PostgresTestDatabase,
) -> Result<PoolAdapterWorkerStratum, Box<dyn Error>> {
    let registry = PostgresStratumSessionRegistry::connect(database.database_url()).await?;
    Ok(PoolAdapterWorkerStratum::new(
        STRATUM_ENDPOINT.to_owned(),
        StratumCredentialIssuer::new([7; 32]),
        registry,
    )?)
}

pub(crate) async fn leased_application(
    database: &PostgresTestDatabase,
) -> Result<AuthorityApplication, Box<dyn Error>> {
    application_with_stratum(database, Arc::new(pool_adapter_stratum(database).await?)).await
}

pub(crate) async fn application_with_stratum(
    database: &PostgresTestDatabase,
    stratum: Arc<dyn WorkerStratumCredentialPort>,
) -> Result<AuthorityApplication, Box<dyn Error>> {
    let issuance = WorkerLeaseIssuance::new(test_lease_signer()?, stratum);
    Ok(
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?
            .with_worker_lease_issuance(issuance)?,
    )
}

pub(crate) async fn create_challenge(
    base_url: &str,
    claimant: &Claimant,
) -> Result<ChallengeId, Box<dyn Error>> {
    let body = reqwest::Client::new()
        .post(format!("{base_url}/v0/challenges"))
        .header(CLIENT_ID_HEADER, CLIENT_ID)
        .bearer_auth(SERVICE_SECRET)
        .json(&json!({
            "action_policy": "account-creation.light.v1",
            "action_reference": format!("action_{}", Uuid::new_v4().simple()),
            "claimant_key": claimant.public_jwk_json
        }))
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    Ok(ChallengeId::try_from(
        body["challenge_id"]
            .as_str()
            .ok_or("challenge response needs an identifier")?
            .to_owned(),
    )?)
}

pub(crate) fn authorization_payload(authorization: &Value) -> Result<Value, Box<dyn Error>> {
    let compact = authorization.as_str().ok_or("authorization is a string")?;
    let mut parts = compact.split('.');
    let (Some(header), Some(payload), Some(signature_part)) =
        (parts.next(), parts.next(), parts.next())
    else {
        return Err("authorization is a compact JWS".into());
    };
    let signer = test_lease_signer()?;
    signature::UnparsedPublicKey::new(&signature::ED25519, signer.public_key())
        .verify(
            format!("{header}.{payload}").as_bytes(),
            &URL_SAFE_NO_PAD.decode(signature_part)?,
        )
        .map_err(|_| "authorization signature must verify")?;
    Ok(serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload)?)?)
}

/// Derives the one claimant Work Session of a challenge, as the Authority does.
pub(crate) fn claimant_session_id(
    challenge_id: &ChallengeId,
) -> Result<bwg_core::progress::WorkSessionId, Box<dyn Error>> {
    let mut input = b"BWG/0.1 claimant Work Session\0".to_vec();
    input.extend_from_slice(challenge_id.as_str().as_bytes());
    let digest = ring::digest::digest(&ring::digest::SHA256, &input);
    Ok(bwg_core::progress::WorkSessionId::try_from(format!(
        "session_{}",
        URL_SAFE_NO_PAD.encode(digest.as_ref())
    ))?)
}
