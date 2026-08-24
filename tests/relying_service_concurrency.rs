use std::{
    error::Error,
    time::{SystemTime, UNIX_EPOCH},
};

use bwg_core::{
    authority::{
        self, AuthorityApplication, AuthorityPublicConfig, DeploymentEnvironment, ServiceCredential,
    },
    challenge::ActionPolicy,
    crypto_profile::{
        AuthorityKeySet, AuthoritySigningKey, GatePassClaimsInput, GatePassConfirmationInput,
    },
    reference_service::{self, ActionProcessingOutcome, ReferenceApplication, TrustedAuthority},
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

const CLIENT_ID: &str = "concurrent-reference-service";
const SERVICE_SECRET: &str = "concurrent-secret-P9vK2mQ7xR4tY8uN3cF6wL1zA5dH0sJ";
const SIGNING_SEED: &str = "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A";
const ISSUER: &str = "https://authority.example";
const AUDIENCE: &str = "https://relying.example";

#[tokio::test]
async fn concurrent_valid_passes_converge_and_are_both_consumed() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let authority =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let authority_url = spawn(authority::router(authority)).await?;
    let reference_listener = TcpListener::bind("127.0.0.1:0").await?;
    let reference_url = format!("http://{}", reference_listener.local_addr()?);
    let redemption_url = format!("{reference_url}/account-creation/redeem");
    let reference = ReferenceApplication::connect_postgres(
        reference_config(authority_url, redemption_url.clone())?,
        database.database_url(),
    )
    .await?;
    spawn_on(reference_listener, reference_service::router(reference));
    let claimant = Claimant::generate()?;
    let challenge = reqwest::Client::new()
        .post(format!("{reference_url}/account-creation/challenge"))
        .json(&json!({ "claimant_key": claimant.public_jwk_json }))
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    let action_reference = challenge["action_reference"]
        .as_str()
        .ok_or("challenge needs an Action Reference")?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let first_pass = signed_pass(&claimant, action_reference, "pass_concurrent_01", now)?;
    let second_pass = signed_pass(&claimant, action_reference, "pass_concurrent_02", now)?;
    let first_dpop = claimant.sign_dpop(&first_pass, &redemption_url, "dpop_concurrent_01", now)?;
    let second_dpop =
        claimant.sign_dpop(&second_pass, &redemption_url, "dpop_concurrent_02", now)?;

    // Act
    let (first, second) = tokio::join!(
        redeem(&reference_url, &first_pass, &first_dpop, action_reference),
        redeem(&reference_url, &second_pass, &second_dpop, action_reference),
    );
    let first = first?.error_for_status()?.json::<Value>().await?;
    let second = second?.error_for_status()?.json::<Value>().await?;
    let first_retry = redeem(
        &reference_url,
        &first_pass,
        &claimant.sign_dpop(&first_pass, &redemption_url, "dpop_concurrent_03", now)?,
        action_reference,
    )
    .await?;
    let second_retry = redeem(
        &reference_url,
        &second_pass,
        &claimant.sign_dpop(&second_pass, &redemption_url, "dpop_concurrent_04", now)?,
        action_reference,
    )
    .await?;

    // Assert
    assert_eq!(first, second);
    assert_eq!(first["outcome"]["status"], "pending");
    assert_eq!(first_retry.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert_eq!(second_retry.status(), reqwest::StatusCode::UNAUTHORIZED);

    Ok(())
}

#[tokio::test]
async fn non_retryable_executor_failure_is_immediately_terminal() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let authority =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let authority_url = spawn(authority::router(authority)).await?;
    let reference_listener = TcpListener::bind("127.0.0.1:0").await?;
    let reference_url = format!("http://{}", reference_listener.local_addr()?);
    let redemption_url = format!("{reference_url}/account-creation/redeem");
    let reference_config = reference_config(authority_url.clone(), redemption_url.clone())?;
    let reference =
        ReferenceApplication::connect_postgres(reference_config.clone(), database.database_url())
            .await?;
    spawn_on(reference_listener, reference_service::router(reference));
    let claimant = Claimant::generate()?;
    let challenge = reqwest::Client::new()
        .post(format!("{reference_url}/account-creation/challenge"))
        .json(&json!({ "claimant_key": claimant.public_jwk_json }))
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    let action_reference = challenge["action_reference"]
        .as_str()
        .ok_or("challenge needs an Action Reference")?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let gate_pass = signed_pass(
        &claimant,
        action_reference,
        "pass_permanent_failure_01",
        now,
    )?;
    let dpop = claimant.sign_dpop(
        &gate_pass,
        &redemption_url,
        "dpop_permanent_failure_01",
        now,
    )?;
    redeem(&reference_url, &gate_pass, &dpop, action_reference)
        .await?
        .error_for_status()?;

    // Act
    let failing = ReferenceApplication::connect_postgres(
        reference_config.with_failing_account_creation_executor("permanent".to_owned())?,
        database.database_url(),
    )
    .await?;
    let execution = failing
        .process_next_action(
            &reference_service::ActionWorkerId::try_from(
                "action_worker_permanent_failure_01".to_owned(),
            )?,
            now,
        )
        .await?;
    let lookup_url = format!("{reference_url}/account-creation/outcomes/{action_reference}");
    let proof = claimant.sign_outcome_proof(
        &lookup_url,
        action_reference,
        "proof_permanent_failure_01",
        now,
    )?;
    let outcome = reqwest::Client::new()
        .get(lookup_url)
        .header(reference_service::CLAIMANT_PROOF_HEADER, proof)
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;

    // Assert
    assert!(matches!(execution, ActionProcessingOutcome::Failed { .. }));
    assert_eq!(outcome["outcome"]["status"], "failed");
    assert_eq!(outcome["outcome"]["reason"], "action_execution_failed");

    Ok(())
}

fn authority_config() -> Result<authority::Config, Box<dyn Error>> {
    let credential = ServiceCredential::new(
        CLIENT_ID,
        SERVICE_SECRET,
        DeploymentEnvironment::Development,
        AUDIENCE.to_owned(),
        vec!["https://app.relying.example".to_owned()],
        vec![ActionPolicy::AccountCreationStandardV1],
    )?;
    let public = AuthorityPublicConfig::new(
        ISSUER,
        ISSUER,
        authority_keys()?,
        "https://authority.example/policies/operator",
        "https://authority.example/privacy",
        "https://authority.example/terms",
    )?;
    Ok(
        authority::Config::new(DeploymentEnvironment::Development, vec![credential], public)?
            .with_signing_key_seed("authority-a".to_owned(), SIGNING_SEED)?,
    )
}

fn reference_config(
    authority_url: String,
    redemption_url: String,
) -> Result<reference_service::Config, Box<dyn Error>> {
    Ok(reference_service::Config::new(
        authority_url,
        CLIENT_ID,
        SERVICE_SECRET,
        AUDIENCE,
        redemption_url,
        TrustedAuthority::new(ISSUER, authority_keys()?)?,
    )?)
}

fn signed_pass(
    claimant: &Claimant,
    action_reference: &str,
    pass_id: &str,
    now: u64,
) -> Result<String, Box<dyn Error>> {
    let keys = AuthorityKeySet::try_from(authority_keys()?)?;
    let signer =
        AuthoritySigningKey::from_seed_base64url("authority-a".to_owned(), SIGNING_SEED, &keys)?;
    Ok(signer.sign_gate_pass(&GatePassClaimsInput {
        iss: ISSUER.to_owned(),
        aud: AUDIENCE.to_owned(),
        iat: now,
        exp: now + 120,
        jti: pass_id.to_owned(),
        challenge_id: "challenge_concurrent_redemption_01".to_owned(),
        protected_action_type: "account_creation".to_owned(),
        action_reference: action_reference.to_owned(),
        action_policy: "account-creation.standard.v1".to_owned(),
        cnf: GatePassConfirmationInput {
            jkt: claimant.jkt()?,
        },
        bwg_version: "BWG/0.1".to_owned(),
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

async fn spawn(router: axum::Router) -> Result<String, Box<dyn Error>> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    spawn_on(listener, router);
    Ok(format!("http://{address}"))
}

fn spawn_on(listener: TcpListener, router: axum::Router) {
    tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("test server should remain available");
    });
}
