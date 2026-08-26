use std::{
    error::Error,
    sync::{Arc, atomic::Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use bwg_core::{
    authority::{self, AuthorityApplication, AuthorityApplicationError},
    challenge::ActionPolicy,
    lifecycle::WorkerClock,
    progress::WorkSessionId,
};
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

#[path = "support/authority_keys.rs"]
mod authority_key_support;
#[path = "support/postgres.rs"]
mod postgres_support;
#[path = "support/running_server.rs"]
mod running_server_support;
#[path = "support/trusted_consent_authority.rs"]
mod trusted_consent_authority_support;
#[path = "support/trusted_consent_http.rs"]
mod trusted_consent_http_support;
#[path = "support/trusted_consent_verifier.rs"]
mod trusted_consent_verifier_support;
use postgres_support::PostgresTestDatabase;
use running_server_support::RunningServer;
use trusted_consent_authority_support::{
    CLIENT_ID, SERVICE_SECRET, authority_config, authority_config_without_signer, issue_challenge,
    issue_elevated_challenge, offer_digest,
};
use trusted_consent_http_support::{
    begin_ceremony, begin_ceremony_response, cancel_challenge, finish_ceremony,
    finish_ceremony_response,
};
use trusted_consent_verifier_support::{ControlledBeginVerifier, ControlledVerifier, FakeVerifier};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn trusted_ceremony_survives_restart_and_finishes_once() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let verifier = Arc::new(FakeVerifier::default());
    let first_application = AuthorityApplication::connect_postgres_with_trusted_consent_verifier(
        authority_config()?,
        database.database_url(),
        verifier.clone(),
    )
    .await?;
    let first_server = RunningServer::spawn(authority::router(first_application)).await?;
    let challenge = issue_elevated_challenge(&first_server.base_url).await?;
    let challenge_id = challenge["challenge_id"]
        .as_str()
        .ok_or("challenge identifier is missing")?;
    let offer_digest = offer_digest(&challenge)?;

    // Act
    let first_begin = begin_ceremony(&first_server.base_url, challenge_id, &offer_digest).await?;
    first_server.stop();
    let restarted = AuthorityApplication::connect_postgres_with_trusted_consent_verifier(
        authority_config()?,
        database.database_url(),
        verifier.clone(),
    )
    .await?;
    let restarted_server = RunningServer::spawn(authority::router(restarted)).await?;
    let repeated_begin =
        begin_ceremony(&restarted_server.base_url, challenge_id, &offer_digest).await?;
    let ceremony_id = first_begin["ceremony_id"]
        .as_str()
        .ok_or("ceremony identifier is missing")?;
    let first_request =
        finish_ceremony_response(&restarted_server.base_url, challenge_id, ceremony_id);
    let second_request =
        finish_ceremony_response(&restarted_server.base_url, challenge_id, ceremony_id);
    let (first_response, second_response) = tokio::join!(first_request, second_request);
    let first_response = first_response?;
    let second_response = second_response?;
    let mut statuses = [first_response.status(), second_response.status()];
    statuses.sort();
    let successful_response = if first_response.status().is_success() {
        first_response
    } else {
        second_response
    };
    let first_finish = successful_response.json::<Value>().await?;
    let pool = PgPool::connect(database.database_url()).await?;
    let retained = sqlx::query_as::<_, (String, Option<Value>, Option<Value>)>(
        "SELECT status, creation_options, registration_state
         FROM gate_authority.trusted_consent_ceremonies WHERE ceremony_id = $1",
    )
    .bind(ceremony_id)
    .fetch_one(&pool)
    .await?;
    restarted_server.stop();
    let after_finish_restart =
        AuthorityApplication::connect_postgres_with_trusted_consent_verifier(
            authority_config_without_signer()?,
            database.database_url(),
            verifier.clone(),
        )
        .await?;
    let after_finish_server = RunningServer::spawn(authority::router(after_finish_restart)).await?;
    let repeated_finish =
        finish_ceremony(&after_finish_server.base_url, challenge_id, ceremony_id).await?;

    // Assert
    assert_eq!(first_begin, repeated_begin);
    assert_eq!(
        first_begin["public_key"]["challenge"],
        "fake-server-challenge"
    );
    let disclosure_digest = first_begin["authority_disclosure_digest_sha256"]
        .as_str()
        .ok_or("Authority disclosure digest is missing")?;
    assert_eq!(disclosure_digest.len(), 43);
    assert_ne!(disclosure_digest, "A".repeat(43));
    assert_eq!(first_finish, repeated_finish);
    assert_eq!(first_finish["status"], "verified");
    assert_eq!(
        first_finish["trusted_consent_receipt"]
            .as_str()
            .ok_or("trusted receipt is missing")?
            .split('.')
            .count(),
        3
    );
    assert_eq!(retained, ("verified".to_owned(), None, None));
    assert_eq!(
        statuses,
        [reqwest::StatusCode::OK, reqwest::StatusCode::CONFLICT]
    );
    assert_eq!(verifier.begin_calls.load(Ordering::SeqCst), 1);
    assert_eq!(verifier.finish_calls.load(Ordering::SeqCst), 1);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_begin_reserves_one_verifier_call() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let verifier = Arc::new(ControlledBeginVerifier::default());
    let application = AuthorityApplication::connect_postgres_with_trusted_consent_verifier(
        authority_config()?,
        database.database_url(),
        verifier.clone(),
    )
    .await?;
    let server = RunningServer::spawn(authority::router(application)).await?;
    let challenge = issue_elevated_challenge(&server.base_url).await?;
    let challenge_id = challenge["challenge_id"].as_str().ok_or("challenge ID")?;
    let offer_digest = offer_digest(&challenge)?;
    let authority_url = server.base_url.clone();
    let challenge_id_owned = challenge_id.to_owned();
    let offer_digest_owned = offer_digest.clone();

    // Act
    let first = tokio::spawn(async move {
        begin_ceremony_response(
            &authority_url,
            &challenge_id_owned,
            &offer_digest_owned,
            "https://authority.example",
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        while verifier.begin_calls.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?;
    let concurrent = begin_ceremony_response(
        &server.base_url,
        challenge_id,
        &offer_digest,
        "https://authority.example",
    )
    .await?;
    verifier.release()?;
    let first = first.await??.error_for_status()?.json::<Value>().await?;

    // Assert
    assert_eq!(concurrent.status(), reqwest::StatusCode::CONFLICT);
    assert_eq!(first["public_key"]["challenge"], "fake-server-challenge");
    assert_eq!(verifier.begin_calls.load(Ordering::SeqCst), 1);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn expired_aborted_begin_reservation_recovers_without_an_orphan() -> Result<(), Box<dyn Error>>
{
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let verifier = Arc::new(ControlledBeginVerifier::default());
    let application = AuthorityApplication::connect_postgres_with_trusted_consent_verifier(
        authority_config()?,
        database.database_url(),
        verifier.clone(),
    )
    .await?;
    let server = RunningServer::spawn(authority::router(application)).await?;
    let challenge = issue_elevated_challenge(&server.base_url).await?;
    let challenge_id = challenge["challenge_id"].as_str().ok_or("challenge ID")?;
    let offer_digest = offer_digest(&challenge)?;
    let authority_url = server.base_url.clone();
    let challenge_id_owned = challenge_id.to_owned();
    let offer_digest_owned = offer_digest.clone();
    let first = tokio::spawn(async move {
        begin_ceremony_response(
            &authority_url,
            &challenge_id_owned,
            &offer_digest_owned,
            "https://authority.example",
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        while verifier.begin_calls.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?;

    // Act
    let before_expiry = begin_ceremony_response(
        &server.base_url,
        challenge_id,
        &offer_digest,
        "https://authority.example",
    )
    .await?;
    let pool = PgPool::connect(database.database_url()).await?;
    sqlx::query(
        "UPDATE gate_authority.trusted_consent_ceremonies
         SET operation_lease_expires_at_unix_seconds = 1
         WHERE status = 'starting' AND challenge_id = $1",
    )
    .bind(challenge_id)
    .execute(&pool)
    .await?;
    first.abort();
    assert!(first.await.is_err());
    let recovery_url = server.base_url.clone();
    let recovery_challenge_id = challenge_id.to_owned();
    let recovery_offer_digest = offer_digest.clone();
    let recovered = tokio::spawn(async move {
        begin_ceremony_response(
            &recovery_url,
            &recovery_challenge_id,
            &recovery_offer_digest,
            "https://authority.example",
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        while verifier.begin_calls.load(Ordering::SeqCst) < 2 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?;
    verifier.release()?;
    let recovered = recovered
        .await??
        .error_for_status()?
        .json::<Value>()
        .await?;
    let states = sqlx::query_as::<_, (i64, i64, i64)>(
        "SELECT COUNT(*),
                COUNT(*) FILTER (WHERE status = 'starting'),
                COUNT(*) FILTER (WHERE status = 'pending')
         FROM gate_authority.trusted_consent_ceremonies WHERE challenge_id = $1",
    )
    .bind(challenge_id)
    .fetch_one(&pool)
    .await?;

    // Assert
    assert_eq!(before_expiry.status(), reqwest::StatusCode::CONFLICT);
    assert_eq!(
        recovered["public_key"]["challenge"],
        "fake-server-challenge"
    );
    assert_eq!(verifier.begin_calls.load(Ordering::SeqCst), 2);
    assert_eq!(states, (1, 0, 1));
    Ok(())
}

#[tokio::test]
async fn elevated_lease_admission_consumes_one_receipt_and_survives_restart()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let verifier = Arc::new(FakeVerifier::default());
    let application = AuthorityApplication::connect_postgres_with_trusted_consent_verifier(
        authority_config()?,
        database.database_url(),
        verifier.clone(),
    )
    .await?;
    let adapter = application.simulated_pool_adapter();
    let server = RunningServer::spawn(authority::router(application)).await?;
    let challenge = issue_elevated_challenge(&server.base_url).await?;
    let challenge_id = challenge["challenge_id"].as_str().ok_or("challenge ID")?;
    let challenge_id = bwg_core::challenge::ChallengeId::try_from(challenge_id.to_owned())?;
    let ceremony = begin_ceremony(
        &server.base_url,
        challenge_id.as_str(),
        &offer_digest(&challenge)?,
    )
    .await?;
    let finished = finish_ceremony(
        &server.base_url,
        challenge_id.as_str(),
        ceremony["ceremony_id"].as_str().ok_or("ceremony ID")?,
    )
    .await?;
    let receipt = finished["trusted_consent_receipt"]
        .as_str()
        .ok_or("trusted receipt")?;
    adapter
        .consent_default_pool_offer_for_simulation(&challenge_id)
        .await?;
    let first_session = WorkSessionId::try_from("session_trusted_receipt_01".to_owned())?;
    let second_session = WorkSessionId::try_from("session_trusted_receipt_02".to_owned())?;
    let third_session = WorkSessionId::try_from("session_trusted_receipt_03".to_owned())?;
    adapter
        .register_session(&challenge_id, first_session.clone())
        .await?;
    adapter
        .register_session(&challenge_id, second_session.clone())
        .await?;
    adapter
        .register_session(&challenge_id, third_session.clone())
        .await?;

    // Act
    let missing = adapter
        .start_lease(&second_session, WorkerClock::new("boot_receipt_02", 1_000)?)
        .await;
    let forged = adapter
        .start_lease_with_trusted_consent(
            &second_session,
            WorkerClock::new("boot_receipt_02", 1_000)?,
            "forged.receipt.bytes",
        )
        .await;
    adapter.fail_session(&first_session).await?;
    let forbidden = adapter
        .start_lease_with_trusted_consent(
            &first_session,
            WorkerClock::new("boot_receipt_01", 1_000)?,
            receipt,
        )
        .await;
    let second_attempt = adapter.start_lease_with_trusted_consent(
        &second_session,
        WorkerClock::new("boot_receipt_02", 1_000)?,
        receipt,
    );
    let third_attempt = adapter.start_lease_with_trusted_consent(
        &third_session,
        WorkerClock::new("boot_receipt_03", 1_000)?,
        receipt,
    );
    let (second_attempt, third_attempt) = tokio::join!(second_attempt, third_attempt);
    let (lease, admitted_session, continuity_id, replay) = match (second_attempt, third_attempt) {
        (Ok(lease), Err(replay)) => (lease, &second_session, "boot_receipt_02", replay),
        (Err(replay), Ok(lease)) => (lease, &third_session, "boot_receipt_03", replay),
        unexpected => return Err(format!("unexpected concurrent admission: {unexpected:?}").into()),
    };
    server.stop();
    let restarted = AuthorityApplication::connect_postgres_with_trusted_consent_verifier(
        authority_config()?,
        database.database_url(),
        verifier,
    )
    .await?
    .simulated_pool_adapter();
    let renewed = restarted
        .renew_lease(
            admitted_session,
            lease.lease_id(),
            WorkerClock::new(continuity_id, 1_100)?,
        )
        .await?;

    // Assert
    assert!(matches!(
        missing,
        Err(AuthorityApplicationError::TrustedConsentRequired)
    ));
    assert!(matches!(
        forged,
        Err(AuthorityApplicationError::InvalidTrustedConsentReceipt)
    ));
    assert!(matches!(
        forbidden,
        Err(AuthorityApplicationError::ForbiddenLifecycleTransition)
    ));
    assert!(matches!(
        replay,
        AuthorityApplicationError::TrustedConsentReceiptReplayed
    ));
    assert_eq!(renewed.lease_id(), lease.lease_id());
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancellation_during_verification_fails_closed() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let verifier = Arc::new(ControlledVerifier::default());
    let application = AuthorityApplication::connect_postgres_with_trusted_consent_verifier(
        authority_config()?,
        database.database_url(),
        verifier.clone(),
    )
    .await?;
    let server = RunningServer::spawn(authority::router(application)).await?;
    let challenge = issue_elevated_challenge(&server.base_url).await?;
    let challenge_id = challenge["challenge_id"].as_str().ok_or("challenge ID")?;
    let ceremony =
        begin_ceremony(&server.base_url, challenge_id, &offer_digest(&challenge)?).await?;
    let ceremony_id = ceremony["ceremony_id"].as_str().ok_or("ceremony ID")?;
    let authority_url = server.base_url.clone();
    let challenge_id_owned = challenge_id.to_owned();
    let ceremony_id_owned = ceremony_id.to_owned();

    // Act
    let finish = tokio::spawn(async move {
        finish_ceremony_response(&authority_url, &challenge_id_owned, &ceremony_id_owned).await
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        while verifier.finish_calls.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?;
    let cancelled =
        cancel_challenge(&server.base_url, challenge_id, CLIENT_ID, SERVICE_SECRET).await?;
    verifier.release()?;
    let finish_response = finish.await??;
    let repeated = finish_ceremony_response(&server.base_url, challenge_id, ceremony_id).await?;

    // Assert
    assert_eq!(cancelled["state"], "cancelled");
    assert_eq!(finish_response.status(), reqwest::StatusCode::GONE);
    assert_eq!(repeated.status(), reqwest::StatusCode::GONE);
    assert_eq!(verifier.finish_calls.load(Ordering::SeqCst), 1);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn expiry_during_verification_cannot_commit_success() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let verifier = Arc::new(ControlledVerifier::default());
    let application = AuthorityApplication::connect_postgres_with_trusted_consent_verifier(
        authority_config()?,
        database.database_url(),
        verifier.clone(),
    )
    .await?;
    let server = RunningServer::spawn(authority::router(application)).await?;
    let challenge = issue_elevated_challenge(&server.base_url).await?;
    let challenge_id = challenge["challenge_id"].as_str().ok_or("challenge ID")?;
    let ceremony =
        begin_ceremony(&server.base_url, challenge_id, &offer_digest(&challenge)?).await?;
    let ceremony_id = ceremony["ceremony_id"].as_str().ok_or("ceremony ID")?;
    let pool = PgPool::connect(database.database_url()).await?;
    let expires_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_secs()
        .checked_add(1)
        .ok_or("test deadline overflow")?;
    sqlx::query(
        "UPDATE gate_authority.trusted_consent_ceremonies
         SET expires_at_unix_seconds = $2 WHERE ceremony_id = $1",
    )
    .bind(ceremony_id)
    .bind(i64::try_from(expires_at)?)
    .execute(&pool)
    .await?;
    let authority_url = server.base_url.clone();
    let challenge_id_owned = challenge_id.to_owned();
    let ceremony_id_owned = ceremony_id.to_owned();

    // Act
    let finish = tokio::spawn(async move {
        finish_ceremony_response(&authority_url, &challenge_id_owned, &ceremony_id_owned).await
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        while verifier.finish_calls.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?;
    tokio::time::sleep(Duration::from_millis(1_100)).await;
    verifier.release()?;
    let response = finish.await??;
    let retained = sqlx::query_as::<_, (String, Option<Value>, Option<Value>)>(
        "SELECT status, creation_options, registration_state
         FROM gate_authority.trusted_consent_ceremonies WHERE ceremony_id = $1",
    )
    .bind(ceremony_id)
    .fetch_one(&pool)
    .await?;

    // Assert
    assert_eq!(response.status(), reqwest::StatusCode::GONE);
    assert_eq!(retained, ("failed".to_owned(), None, None));
    assert_eq!(verifier.finish_calls.load(Ordering::SeqCst), 1);
    Ok(())
}

#[tokio::test]
async fn stale_verification_is_retired_without_reverification() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let verifier = Arc::new(FakeVerifier::default());
    let application = AuthorityApplication::connect_postgres_with_trusted_consent_verifier(
        authority_config()?,
        database.database_url(),
        verifier.clone(),
    )
    .await?;
    let server = RunningServer::spawn(authority::router(application)).await?;
    let challenge = issue_elevated_challenge(&server.base_url).await?;
    let challenge_id = challenge["challenge_id"].as_str().ok_or("challenge ID")?;
    let ceremony =
        begin_ceremony(&server.base_url, challenge_id, &offer_digest(&challenge)?).await?;
    let ceremony_id = ceremony["ceremony_id"].as_str().ok_or("ceremony ID")?;
    let pool = PgPool::connect(database.database_url()).await?;
    sqlx::query(
        "UPDATE gate_authority.trusted_consent_ceremonies
         SET status = 'verifying', operation_owner = $2::uuid,
             operation_lease_expires_at_unix_seconds = 1
         WHERE ceremony_id = $1",
    )
    .bind(ceremony_id)
    .bind(Uuid::new_v4().to_string())
    .execute(&pool)
    .await?;

    // Act
    let response = finish_ceremony_response(&server.base_url, challenge_id, ceremony_id).await?;
    let retained = sqlx::query_as::<_, (String, Option<Value>, Option<Value>)>(
        "SELECT status, creation_options, registration_state
         FROM gate_authority.trusted_consent_ceremonies WHERE ceremony_id = $1",
    )
    .bind(ceremony_id)
    .fetch_one(&pool)
    .await?;

    // Assert
    assert_eq!(response.status(), reqwest::StatusCode::GONE);
    assert_eq!(retained, ("failed".to_owned(), None, None));
    assert_eq!(verifier.finish_calls.load(Ordering::SeqCst), 0);
    Ok(())
}

#[tokio::test]
async fn begin_rejects_non_required_and_mismatched_bindings_before_webauthn()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let verifier = Arc::new(FakeVerifier::default());
    let application = AuthorityApplication::connect_postgres_with_trusted_consent_verifier(
        authority_config()?,
        database.database_url(),
        verifier.clone(),
    )
    .await?;
    let server = RunningServer::spawn(authority::router(application)).await?;
    let standard = issue_challenge(
        &server.base_url,
        ActionPolicy::ACCOUNT_CREATION_STANDARD_V1,
        "action_trusted_standard_01",
    )
    .await?;
    let elevated = issue_challenge(
        &server.base_url,
        ActionPolicy::ACCOUNT_CREATION_ELEVATED_V1,
        "action_trusted_elevated_02",
    )
    .await?;

    // Act
    let standard_response = begin_ceremony_response(
        &server.base_url,
        standard["challenge_id"]
            .as_str()
            .ok_or("standard challenge ID")?,
        &offer_digest(&standard)?,
        "https://authority.example",
    )
    .await?;
    let wrong_digest = begin_ceremony_response(
        &server.base_url,
        elevated["challenge_id"]
            .as_str()
            .ok_or("elevated challenge ID")?,
        &"Z".repeat(43),
        "https://authority.example",
    )
    .await?;
    let wrong_origin = begin_ceremony_response(
        &server.base_url,
        elevated["challenge_id"]
            .as_str()
            .ok_or("elevated challenge ID")?,
        &offer_digest(&elevated)?,
        "https://evil.example",
    )
    .await?;

    // Assert
    assert_eq!(standard_response.status(), reqwest::StatusCode::BAD_REQUEST);
    assert_eq!(wrong_digest.status(), reqwest::StatusCode::BAD_REQUEST);
    assert_eq!(wrong_origin.status(), reqwest::StatusCode::BAD_REQUEST);
    assert_eq!(verifier.begin_calls.load(Ordering::SeqCst), 0);
    Ok(())
}
