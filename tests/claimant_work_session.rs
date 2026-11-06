//! Claimant Work Session routes issue signed Worker Leases (ADR-0106).

use std::{
    error::Error,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use bwg_core::{
    authority::{
        self, AuthorityApplication, AuthorityApplicationError, PoolSelectionIntake,
        WorkerLeaseIssuance, WorkerStratumCredentialPort, WorkerStratumRequest,
        WorkerStratumUnavailable,
    },
    challenge::ChallengeId,
    stratum_v1::{
        PoolAdapterWorkerStratum, PostgresStratumSessionRegistry, StratumCredentialIssuer,
    },
    work_lease_authorization::{WorkLeaseAuthoritySigner, WorkerStratumV1},
};
use reqwest::StatusCode;
use serde_json::{Value, json};

#[path = "support/authority_keys.rs"]
mod authority_key_support;
#[path = "support/claimant.rs"]
mod claimant_support;
#[path = "support/claimant_work_session.rs"]
mod fixture;
#[path = "support/postgres.rs"]
mod postgres_support;
#[path = "support/running_server.rs"]
mod running_server;
use claimant_support::Claimant;
use fixture::*;
use postgres_support::PostgresTestDatabase;
use running_server::RunningServer;

/// Pool Adapter port that fails its first issuance, as an unavailable adapter would.
struct FailingOnceStratum {
    inner: PoolAdapterWorkerStratum,
    failed: AtomicBool,
}

#[async_trait::async_trait]
impl WorkerStratumCredentialPort for FailingOnceStratum {
    async fn issue(
        &self,
        request: WorkerStratumRequest,
    ) -> Result<WorkerStratumV1, WorkerStratumUnavailable> {
        if !self.failed.swap(true, Ordering::SeqCst) {
            return Err(WorkerStratumUnavailable);
        }
        self.inner.issue(request).await
    }

    async fn renew(&self, request: WorkerStratumRequest) -> Result<(), WorkerStratumUnavailable> {
        self.inner.renew(request).await
    }

    async fn record_pool_selection(
        &self,
        intake: PoolSelectionIntake,
    ) -> Result<(), WorkerStratumUnavailable> {
        self.inner.record_pool_selection(intake).await
    }

    async fn release_pool_selection(
        &self,
        challenge_id: &ChallengeId,
    ) -> Result<(), WorkerStratumUnavailable> {
        self.inner.release_pool_selection(challenge_id).await
    }
}

#[tokio::test]
async fn start_returns_a_signed_grant_with_lease_scoped_stratum_credentials()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let fixture = Fixture::start().await?;

    // Act
    let grant = fixture.start_work().await?;

    // Assert
    let payload = authorization_payload(&grant["authorization"])?;
    assert_eq!(grant["protocolVersion"], "bwg-worker-controller/0.4");
    assert_eq!(grant["challengeId"], fixture.challenge_id.as_str());
    assert_eq!(grant["durationMilliseconds"], 60_000);
    assert_eq!(grant["renewAfterMilliseconds"], 20_000);
    assert_eq!(grant["stratum"]["endpoint"], STRATUM_ENDPOINT);
    assert!(
        grant["stratum"]["username"]
            .as_str()
            .is_some_and(|username| username.starts_with("bwg_"))
    );
    assert_eq!(
        payload,
        json!({
            "controlSessionBindingSha256": CONTROL_SESSION,
            "operation": "start",
            "requestSha256": payload["requestSha256"],
            "sequence": "1"
        })
    );
    Ok(())
}

#[tokio::test]
async fn renew_returns_a_renewal_under_the_next_sequence() -> Result<(), Box<dyn Error>> {
    // Arrange
    let fixture = Fixture::start().await?;
    let grant = fixture.start_work().await?;

    // Act
    let renewal: Value = fixture
        .renew(&grant["leaseId"], CONTROL_SESSION)
        .await?
        .error_for_status()?
        .json()
        .await?;

    // Assert
    let payload = authorization_payload(&renewal["authorization"])?;
    assert_eq!(renewal["leaseId"], grant["leaseId"]);
    assert_eq!(payload["operation"], "renew");
    assert_eq!(payload["sequence"], "2");
    Ok(())
}

#[tokio::test]
async fn renew_extends_the_stratum_session_under_the_same_password() -> Result<(), Box<dyn Error>> {
    // Arrange
    let fixture = Fixture::start().await?;
    let grant = fixture.start_work().await?;
    let registry = PostgresStratumSessionRegistry::connect(fixture.database.database_url()).await?;
    let username = grant["stratum"]["username"].as_str().ok_or("username")?;
    let password = grant["stratum"]["password"].as_str().ok_or("password")?;
    let granted = registry
        .authenticate(username, password, now()?)
        .await?
        .ok_or("granted credentials must authenticate")?;

    // Act
    fixture
        .renew(&grant["leaseId"], CONTROL_SESSION)
        .await?
        .error_for_status()?;
    let renewed = registry
        .authenticate(username, password, now()?)
        .await?
        .ok_or("the granted password must still authenticate after Renew")?;

    // Assert
    assert!(
        renewed.lease_context().last_monotonic_milliseconds()
            > granted.lease_context().last_monotonic_milliseconds()
    );
    assert!(
        renewed.lease_context().expires_at_monotonic_milliseconds()
            > granted.lease_context().expires_at_monotonic_milliseconds()
    );
    assert!(renewed.expires_at_unix_seconds() >= granted.expires_at_unix_seconds());
    Ok(())
}

#[tokio::test]
async fn renew_after_claimant_pause_is_refused() -> Result<(), Box<dyn Error>> {
    // Arrange
    let fixture = Fixture::start().await?;
    let grant = fixture.start_work().await?;
    fixture.pause().await?;

    // Act
    let response = fixture.renew(&grant["leaseId"], CONTROL_SESSION).await?;

    // Assert
    assert_eq!(response.status(), StatusCode::CONFLICT);
    Ok(())
}

#[tokio::test]
async fn renew_under_another_control_session_is_refused() -> Result<(), Box<dyn Error>> {
    // Arrange
    let fixture = Fixture::start().await?;
    let grant = fixture.start_work().await?;

    // Act
    let response = fixture
        .renew(&grant["leaseId"], OTHER_CONTROL_SESSION)
        .await?;

    // Assert
    assert_eq!(response.status(), StatusCode::CONFLICT);
    Ok(())
}

#[tokio::test]
async fn resume_after_claimant_pause_returns_a_fresh_grant() -> Result<(), Box<dyn Error>> {
    // Arrange
    let fixture = Fixture::start().await?;
    let first = fixture.start_work().await?;
    fixture.pause().await?;

    // Act
    let resumed: Value = fixture
        .post(
            "resume",
            &json!({ "control_session_binding_sha256": OTHER_CONTROL_SESSION }),
        )
        .await?
        .error_for_status()?
        .json()
        .await?;

    // Assert
    let payload = authorization_payload(&resumed["authorization"])?;
    assert_ne!(resumed["leaseId"], first["leaseId"]);
    assert_eq!(payload["operation"], "start");
    assert_eq!(
        payload["controlSessionBindingSha256"],
        OTHER_CONTROL_SESSION
    );
    Ok(())
}

#[tokio::test]
async fn resume_after_claimant_cancel_is_refused() -> Result<(), Box<dyn Error>> {
    // Arrange
    let fixture = Fixture::start().await?;
    fixture.start_work().await?;
    fixture
        .post("cancel", &json!({ "confirm_progress_loss": true }))
        .await?
        .error_for_status()?;

    // Act
    let response = fixture
        .post(
            "resume",
            &json!({ "control_session_binding_sha256": CONTROL_SESSION }),
        )
        .await?;

    // Assert
    assert_eq!(response.status(), StatusCode::CONFLICT);
    Ok(())
}

#[tokio::test]
async fn replayed_claimant_proof_is_refused() -> Result<(), Box<dyn Error>> {
    // Arrange
    let fixture = Fixture::start().await?;
    let body = serde_json::to_vec(&json!({ "reason": "user_requested" }))?;
    let proof = fixture.proof("pause", &body)?;
    fixture
        .send("pause", body.clone(), &proof)
        .await?
        .error_for_status()?;

    // Act
    let response = fixture.send("pause", body, &proof).await?;

    // Assert
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    Ok(())
}

#[tokio::test]
async fn claimant_proof_for_another_body_is_refused() -> Result<(), Box<dyn Error>> {
    // Arrange
    let fixture = Fixture::start().await?;
    let signed_body = serde_json::to_vec(&json!({
        "control_session_binding_sha256": CONTROL_SESSION
    }))?;
    let proof = fixture.proof("start", &signed_body)?;
    let sent_body = serde_json::to_vec(&json!({
        "control_session_binding_sha256": OTHER_CONTROL_SESSION
    }))?;

    // Act
    let response = fixture.send("start", sent_body, &proof).await?;

    // Assert
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    Ok(())
}

#[tokio::test]
async fn sequence_continues_after_the_authority_restarts() -> Result<(), Box<dyn Error>> {
    // Arrange
    let mut fixture = Fixture::start().await?;
    let grant = fixture.start_work().await?;
    let restarted = leased_application(&fixture.database).await?;
    let previous = std::mem::replace(
        &mut fixture.server,
        RunningServer::spawn(authority::router(restarted)).await?,
    );
    previous.stop();

    // Act
    let renewal: Value = fixture
        .renew(&grant["leaseId"], CONTROL_SESSION)
        .await?
        .error_for_status()?
        .json()
        .await?;

    // Assert
    assert_eq!(
        authorization_payload(&renewal["authorization"])?["sequence"],
        "2"
    );
    Ok(())
}

#[tokio::test]
async fn start_without_worker_lease_issuance_is_unavailable() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let server = RunningServer::spawn(authority::router(application.clone())).await?;
    let claimant = Claimant::generate()?;
    let challenge_id = create_challenge(&server.base_url, &claimant).await?;
    let fixture = Fixture {
        database,
        application,
        server,
        claimant,
        challenge_id,
    };

    // Act
    let response = fixture
        .post(
            "start",
            &json!({ "control_session_binding_sha256": CONTROL_SESSION }),
        )
        .await?;

    // Assert
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    Ok(())
}

#[tokio::test]
async fn gate_pass_key_cannot_sign_worker_leases() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let registry = PostgresStratumSessionRegistry::connect(database.database_url()).await?;
    let stratum = PoolAdapterWorkerStratum::new(
        STRATUM_ENDPOINT.to_owned(),
        StratumCredentialIssuer::new([7; 32]),
        registry,
    )?;
    let reused = WorkLeaseAuthoritySigner::from_seed_base64url(
        "authority-a".to_owned(),
        "test-work-lease-authority".to_owned(),
        AUTHORITY_SIGNING_SEED,
    )?;
    let application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;

    // Act
    let result =
        application.with_worker_lease_issuance(WorkerLeaseIssuance::new(reused, Arc::new(stratum)));

    // Assert
    assert!(matches!(
        result,
        Err(AuthorityApplicationError::WorkLeaseKeyReused)
    ));
    Ok(())
}

#[tokio::test]
async fn start_after_an_ungranted_lease_can_lease_again() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let stratum = FailingOnceStratum {
        inner: pool_adapter_stratum(&database).await?,
        failed: AtomicBool::new(false),
    };
    let application = application_with_stratum(&database, Arc::new(stratum)).await?;
    let server = RunningServer::spawn(authority::router(application.clone())).await?;
    let claimant = Claimant::generate()?;
    let challenge_id = create_challenge(&server.base_url, &claimant).await?;
    application
        .simulated_pool_adapter()
        .consent_default_pool_offer_for_simulation(&challenge_id)
        .await?;
    let fixture = Fixture {
        database,
        application,
        server,
        claimant,
        challenge_id,
    };
    let start_body = json!({ "control_session_binding_sha256": CONTROL_SESSION });
    let unavailable = fixture.post("start", &start_body).await?.status();

    // Act
    let retried = fixture.post("start", &start_body).await?;

    // Assert
    assert_eq!(unavailable, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(retried.status(), StatusCode::OK);
    Ok(())
}
