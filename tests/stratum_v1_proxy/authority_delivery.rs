use std::{error::Error, sync::Mutex};

use async_trait::async_trait;
use axum::Router;
use bwg_core::{
    authority::{
        self, AuthorityApplication, AuthorityPublicConfig, CLIENT_ID_HEADER, Config,
        DeploymentEnvironment, ServiceCredential, SimulatedPoolAdapter,
    },
    challenge::{ActionPolicy, ChallengeId},
    lifecycle::WorkerClock,
    progress::{AcceptedWorkAcknowledgement, AcceptedWorkEvent, WorkSessionId},
    stratum_v1::{
        AcceptedWorkDeliveryWorker, AcceptedWorkSink, AcceptedWorkSinkError, DeliveryOutcome,
        PostgresAcceptedWorkOutbox, StratumLeaseContext,
    },
};
use serde_json::{Value, json};
use tokio::net::TcpListener;

use super::{PostgresTestDatabase, persisted_event};

#[path = "../support/authority_keys.rs"]
mod authority_key_support;
use authority_key_support::{CLAIMANT_PUBLIC_JWK, authority_keys};

const CLIENT_ID: &str = "stratum-reference-service";
const SERVICE_SECRET: &str = "stratum-secret-P9vK2mQ7xR4tY8uN3cF6wL1zA5dH0sJ";
const AUTHORITY_SIGNING_SEED: &str = "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A";

#[tokio::test]
async fn durable_proxy_event_advances_the_existing_authority_progress_path()
-> Result<(), Box<dyn Error>> {
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
            "action_reference": "action_stratum_delivery_01",
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
    let session_id = WorkSessionId::try_from("session_stratum_outbox_01".to_owned())?;
    adapter
        .consent_default_pool_offer_for_simulation(&challenge_id)
        .await?;
    adapter.register_session(&challenge_id, session_id).await?;
    let lease = adapter
        .start_lease(
            &WorkSessionId::try_from("session_stratum_outbox_01".to_owned())?,
            WorkerClock::new("boot_stratum_delivery_01", 0)?,
        )
        .await?;
    let lease_context = StratumLeaseContext::new(
        lease.lease_id().to_owned(),
        "boot_stratum_delivery_01".to_owned(),
        0,
        lease.renew_at_monotonic_milliseconds(),
        lease.expires_at_monotonic_milliseconds(),
    )?;
    let event = persisted_event("event_stratum_authority_01", "share_stratum_authority_01")?;
    let outbox = PostgresAcceptedWorkOutbox::connect(database.database_url()).await?;
    outbox
        .persist(
            &event,
            &lease_context,
            r#"{"id":51,"result":true,"error":null}"#,
        )
        .await?;
    let worker =
        AcceptedWorkDeliveryWorker::new(outbox, "delivery_worker_authority".to_owned(), 30)?;
    let sink = SimulatedAuthoritySink {
        adapter,
        acknowledgements: Mutex::new(Vec::new()),
    };

    // Act
    let outcome = worker.deliver_one(&sink, 1_000).await?;
    let acknowledgement = sink
        .acknowledgements
        .into_inner()?
        .pop()
        .ok_or("Authority acknowledgement must be retained")?;

    // Assert
    assert_eq!(outcome, DeliveryOutcome::Acknowledged);
    assert_eq!(
        acknowledgement.verified_progress().to_decimal_string(),
        "4295032833"
    );
    Ok(())
}

struct SimulatedAuthoritySink {
    adapter: SimulatedPoolAdapter,
    acknowledgements: Mutex<Vec<AcceptedWorkAcknowledgement>>,
}

#[async_trait]
impl AcceptedWorkSink for SimulatedAuthoritySink {
    async fn deliver(
        &self,
        event: AcceptedWorkEvent,
        lease_context: StratumLeaseContext,
    ) -> Result<(), AcceptedWorkSinkError> {
        let acknowledgement = self
            .adapter
            .report_stratum(event, &lease_context)
            .await
            .map_err(|_| AcceptedWorkSinkError::Unavailable)?;
        self.acknowledgements
            .lock()
            .map_err(|_| AcceptedWorkSinkError::Unavailable)?
            .push(acknowledgement);
        Ok(())
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
