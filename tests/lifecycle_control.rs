use std::{
    borrow::Cow,
    error::Error,
    str::FromStr as _,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::Router;
use bwg_core::{
    authority::{
        self, AuthorityApplication, AuthorityApplicationError, AuthorityPublicConfig,
        CLIENT_ID_HEADER, Config, DeploymentEnvironment, IssuanceWorkerId, ServiceCredential,
    },
    challenge::{ActionPolicy, ChallengeId},
    lifecycle::{
        ChallengeLifecycleCommand, ChallengeLifecycleState, DPOP_ACCEPTANCE_WINDOW_SECONDS,
        DPOP_FRESHNESS_SECONDS, GATE_PASS_TTL_SECONDS, PROTOCOL_CLOCK_SKEW_SECONDS, PauseReason,
        SessionLifecycleCommand, SessionLifecycleState, WORK_CHALLENGE_TTL_SECONDS,
        WORK_LEASE_MAX_DURATION_SECONDS, WORK_LEASE_RENEWAL_SECONDS, WorkerClock,
        WorkerInterruption, apply_challenge_command, apply_session_command,
        challenge_transition_allowed, request_proof_is_fresh, session_transition_allowed,
        signed_artifact_is_time_valid,
    },
    progress::{
        AcceptedWorkEvent, AcceptedWorkEventId, AcceptedWorkEventInput, NetworkTargetOutcome,
        ReceiptTime, ShareFingerprint, WorkSessionId,
    },
};
use serde_json::{Value, json};
use tokio::net::TcpListener;

#[path = "support/authority_keys.rs"]
mod authority_key_support;
#[path = "support/postgres.rs"]
mod postgres_support;
use authority_key_support::{CLAIMANT_PUBLIC_JWK, authority_keys};
use postgres_support::PostgresTestDatabase;

const CLIENT_ID: &str = "lifecycle-reference-service";
const SERVICE_SECRET: &str = "lifecycle-secret-P9vK2mQ7xR4tY8uN3cF6wL1zA5dH0sJ";
const OTHER_CLIENT_ID: &str = "other-lifecycle-reference-service";
const OTHER_SERVICE_SECRET: &str = "other-lifecycle-Q7tY2mP9xR4vN8uK3cF6wL1zA5dH0sJ";
const AUTHORITY_SIGNING_SEED: &str = "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A";

#[path = "lifecycle_control/challenge.rs"]
mod challenge_lifecycle;
#[path = "lifecycle_control/leases.rs"]
mod lease_lifecycle;
#[path = "lifecycle_control/concurrency.rs"]
mod lifecycle_concurrency;
#[path = "lifecycle_control/model.rs"]
mod lifecycle_model;
struct LifecycleFixture {
    _database: PostgresTestDatabase,
    application: AuthorityApplication,
    adapter: bwg_core::authority::SimulatedPoolAdapter,
    authority_url: String,
}

impl LifecycleFixture {
    async fn start() -> Result<Self, Box<dyn Error>> {
        let database = PostgresTestDatabase::start().await?;
        let application =
            AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
                .await?;
        let adapter = application.simulated_pool_adapter();
        let authority_url = spawn_http(authority::router(application.clone())).await?;
        Ok(Self {
            _database: database,
            application,
            adapter,
            authority_url,
        })
    }

    async fn lifecycle(&self, challenge_id: &ChallengeId) -> Result<Value, Box<dyn Error>> {
        Ok(reqwest::get(format!(
            "{}/v0/challenges/{}/lifecycle",
            self.authority_url,
            challenge_id.as_str()
        ))
        .await?
        .error_for_status()?
        .json()
        .await?)
    }

    async fn create_challenge(
        &self,
        action_reference: &str,
    ) -> Result<ChallengeId, Box<dyn Error>> {
        let body = reqwest::Client::new()
            .post(format!("{}/v0/challenges", self.authority_url))
            .header(CLIENT_ID_HEADER, CLIENT_ID)
            .bearer_auth(SERVICE_SECRET)
            .json(&json!({
                "action_policy": "account-creation.light.v1",
                "action_reference": action_reference,
                "claimant_key": CLAIMANT_PUBLIC_JWK
            }))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        let challenge_id = ChallengeId::try_from(
            body["challenge_id"]
                .as_str()
                .ok_or("challenge response needs an identifier")?
                .to_owned(),
        )?;
        self.adapter
            .consent_default_pool_offer_for_simulation(&challenge_id)
            .await?;
        Ok(challenge_id)
    }

    async fn pause(
        &self,
        challenge_id: &ChallengeId,
        reason: PauseReason,
    ) -> Result<Value, Box<dyn Error>> {
        Ok(reqwest::Client::new()
            .post(format!(
                "{}/v0/challenges/{}/pause",
                self.authority_url,
                challenge_id.as_str()
            ))
            .header(CLIENT_ID_HEADER, CLIENT_ID)
            .bearer_auth(SERVICE_SECRET)
            .json(&json!({ "reason": reason }))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?)
    }

    async fn cancel(
        &self,
        challenge_id: &ChallengeId,
        confirm_progress_loss: bool,
    ) -> Result<reqwest::Response, Box<dyn Error>> {
        Ok(reqwest::Client::new()
            .post(format!(
                "{}/v0/challenges/{}/cancel",
                self.authority_url,
                challenge_id.as_str()
            ))
            .header(CLIENT_ID_HEADER, CLIENT_ID)
            .bearer_auth(SERVICE_SECRET)
            .json(&json!({ "confirm_progress_loss": confirm_progress_loss }))
            .send()
            .await?)
    }
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
    let other_credential = ServiceCredential::new(
        OTHER_CLIENT_ID,
        OTHER_SERVICE_SECRET,
        DeploymentEnvironment::Development,
        "https://other-relying.example".to_owned(),
        vec!["https://other-app.relying.example".to_owned()],
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
        vec![credential, other_credential],
        public,
    )?
    .with_signing_key_seed("authority-a".to_owned(), AUTHORITY_SIGNING_SEED)?)
}

fn work_event(
    event_id: &str,
    share_fingerprint: &str,
    session_id: WorkSessionId,
    assigned_target: [u8; 32],
) -> Result<AcceptedWorkEvent, Box<dyn Error>> {
    Ok(AcceptedWorkEvent::try_from(AcceptedWorkEventInput {
        event_id: AcceptedWorkEventId::try_from(event_id.to_owned())?,
        work_session_id: session_id,
        assigned_target,
        received_at: ReceiptTime::try_from(current_unix_seconds()?)?,
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

fn light_threshold_target() -> [u8; 32] {
    let mut target = [0xff_u8; 32];
    target[..5].fill(0);
    target[5] = 0x3f;
    target
}

fn current_unix_seconds() -> Result<u64, std::time::SystemTimeError> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs())
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
