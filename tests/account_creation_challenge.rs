use std::{
    collections::BTreeSet,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::Router;
use bwg_core::{
    authority::{
        self, AuthorityApplication, AuthorityPublicConfig, DeploymentEnvironment, ServiceCredential,
    },
    challenge::ActionPolicy,
    reference_service,
};
use serde_json::{Value, json};
use tokio::net::TcpListener;

const SERVICE_CREDENTIAL: &str = "test-secret-P9vK2mQ7xR4tY8uN3cF6wL1zA5dH0sJ";
const SERVICE_CLIENT_ID: &str = "reference-service-test";
const TRUSTED_AUTHORITY_ISSUER: &str = "https://authority.example";
const RELYING_SERVICE_AUDIENCE: &str = "https://relying.example";
const REDEMPTION_URL: &str = "http://127.0.0.1:1/account-creation/redeem";

#[path = "support/authority_keys.rs"]
mod authority_key_support;
#[path = "support/postgres.rs"]
mod postgres_support;
use authority_key_support::{CLAIMANT_PUBLIC_JWK, authority_keys};
use postgres_support::PostgresTestDatabase;

#[tokio::test]
async fn reference_backend_issues_a_browser_safe_standard_challenge()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let (authority_url, _database) = spawn_authority(authority_config()?).await?;
    let reference_url = spawn_http(reference_service::router(reference_service::Config::new(
        authority_url,
        SERVICE_CLIENT_ID,
        SERVICE_CREDENTIAL,
        RELYING_SERVICE_AUDIENCE,
        REDEMPTION_URL,
        trusted_authority()?,
    )?))
    .await?;
    let client = reqwest::Client::new();
    let request_started_at = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();

    // Act
    let response = client
        .post(format!("{reference_url}/account-creation/challenge"))
        .json(&json!({
            "claimant_key": CLAIMANT_PUBLIC_JWK
        }))
        .send()
        .await?;

    // Assert
    assert_eq!(response.status(), reqwest::StatusCode::CREATED);
    let descriptor: Value = response.json().await?;
    let request_finished_at = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let actual_fields = descriptor
        .as_object()
        .ok_or("challenge descriptor must be a JSON object")?
        .keys()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let expected_fields = BTreeSet::from([
        "action_policy",
        "action_reference",
        "allowed_origins",
        "challenge_id",
        "claimant_key",
        "expires_at_unix_seconds",
        "protocol_version",
        "relying_service_audience",
        "work_requirement",
    ]);

    assert_eq!(actual_fields, expected_fields);
    assert_eq!(descriptor["action_policy"], "account-creation.standard.v1");
    assert!(
        descriptor["action_reference"]
            .as_str()
            .is_some_and(|value| value.starts_with("action_"))
    );
    assert_eq!(descriptor["claimant_key"], CLAIMANT_PUBLIC_JWK);
    assert_eq!(
        descriptor["relying_service_audience"],
        "https://relying.example"
    );
    assert_eq!(
        descriptor["allowed_origins"],
        json!(["https://app.relying.example"])
    );
    assert_eq!(descriptor["protocol_version"], "BWG/0.1");
    assert_eq!(
        descriptor["work_requirement"]["expected_hashes"],
        "17592186044416"
    );
    assert!(descriptor["challenge_id"].as_str().is_some());
    let expires_at = descriptor["expires_at_unix_seconds"]
        .as_u64()
        .ok_or("challenge expiry must be an unsigned integer")?;
    assert!(expires_at >= request_started_at + 900);
    assert!(expires_at <= request_finished_at + 900);
    assert!(!descriptor.to_string().contains(SERVICE_CREDENTIAL));

    Ok(())
}

#[tokio::test]
async fn browser_cannot_supply_authoritative_challenge_terms()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let (authority_url, _database) = spawn_authority(authority_config()?).await?;
    let reference_url = spawn_http(reference_service::router(reference_service::Config::new(
        authority_url,
        SERVICE_CLIENT_ID,
        SERVICE_CREDENTIAL,
        RELYING_SERVICE_AUDIENCE,
        REDEMPTION_URL,
        trusted_authority()?,
    )?))
    .await?;

    // Act
    let response = reqwest::Client::new()
        .post(format!("{reference_url}/account-creation/challenge"))
        .json(&json!({
            "claimant_key": CLAIMANT_PUBLIC_JWK,
            "action_policy": "account-creation.light.v0",
            "action_reference": "customer@example.com",
            "work_requirement": { "expected_hashes": "1" },
            "action_payload": { "email": "customer@example.com" },
            "account_identifier": "account_123"
        }))
        .send()
        .await?;

    // Assert
    assert_eq!(response.status(), reqwest::StatusCode::UNPROCESSABLE_ENTITY);

    Ok(())
}

#[tokio::test]
async fn authority_rejects_unauthenticated_challenge_issuance()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let (authority_url, _database) = spawn_authority(authority_config()?).await?;

    // Act
    let response = reqwest::Client::new()
        .post(format!("{authority_url}/v0/challenges"))
        .json(&json!({
            "action_policy": "account-creation.light.v1",
            "action_reference": "action_Z9x3pK7m",
            "claimant_key": CLAIMANT_PUBLIC_JWK
        }))
        .send()
        .await?;

    // Assert
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert_eq!(
        response.json::<Value>().await?,
        json!({ "error": "unauthorized" })
    );

    Ok(())
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

async fn spawn_authority(
    config: authority::Config,
) -> Result<(String, PostgresTestDatabase), Box<dyn std::error::Error>> {
    let database = PostgresTestDatabase::start().await?;
    let application =
        AuthorityApplication::connect_postgres(config, database.database_url()).await?;
    let authority_url = spawn_http(authority::router(application)).await?;
    Ok((authority_url, database))
}

fn authority_config() -> Result<authority::Config, Box<dyn std::error::Error>> {
    let credential = ServiceCredential::new(
        SERVICE_CLIENT_ID,
        SERVICE_CREDENTIAL,
        DeploymentEnvironment::Development,
        "https://relying.example".to_owned(),
        vec!["https://app.relying.example".to_owned()],
        vec![ActionPolicy::AccountCreationStandardV1],
    )?;
    let public = AuthorityPublicConfig::new(
        TRUSTED_AUTHORITY_ISSUER,
        TRUSTED_AUTHORITY_ISSUER,
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

fn trusted_authority() -> Result<reference_service::TrustedAuthority, Box<dyn std::error::Error>> {
    Ok(reference_service::TrustedAuthority::new(
        TRUSTED_AUTHORITY_ISSUER,
        authority_keys()?,
    )?)
}
