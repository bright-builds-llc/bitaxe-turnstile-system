use axum::Router;
use bwg_core::{
    authority::{
        self, AuthorityConfigError, AuthorityPublicConfig, CLIENT_ID_HEADER, Config,
        DeploymentEnvironment, ServiceCredential,
    },
    authority_descriptor::AuthorityDescriptor,
    challenge::ActionPolicy,
    crypto_profile::AuthorityJwkWire,
    reference_service,
};
use serde_json::{Value, json};
use tokio::net::TcpListener;

const CLIENT_ID: &str = "reference-service-production";
const SERVICE_SECRET: &str = "production-secret-7zZszCLVD82lfejKM4g4nXGQ9";

#[tokio::test]
async fn scoped_backend_credential_issues_browser_safe_challenge()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let authority_url = spawn_http(authority::router(authority_config()?)).await?;

    // Act
    let response = reqwest::Client::new()
        .post(format!("{authority_url}/v0/challenges"))
        .header(CLIENT_ID_HEADER, CLIENT_ID)
        .bearer_auth(SERVICE_SECRET)
        .json(&json!({
            "action_policy": "account-creation.light.v1",
            "action_reference": "action_secure_01",
            "claimant_key": "claimant_key_secure_01"
        }))
        .send()
        .await?;

    // Assert
    assert_eq!(response.status(), reqwest::StatusCode::CREATED);
    let descriptor = response.json::<Value>().await?;
    let public_json = descriptor.to_string();
    assert_eq!(
        descriptor["relying_service_audience"],
        "https://relying.example"
    );
    assert_eq!(
        descriptor["allowed_origins"],
        json!(["https://app.relying.example"])
    );
    assert!(!public_json.contains(CLIENT_ID));
    assert!(!public_json.contains(SERVICE_SECRET));

    Ok(())
}

#[test]
fn short_service_secret_is_rejected() {
    // Arrange
    let short_secret = "too-short";

    // Act
    let result = ServiceCredential::new(
        CLIENT_ID,
        short_secret,
        DeploymentEnvironment::Production,
        "https://relying.example".to_owned(),
        vec!["https://app.relying.example".to_owned()],
        vec![ActionPolicy::AccountCreationLightV1],
    );

    // Assert
    assert!(matches!(
        result,
        Err(AuthorityConfigError::InvalidServiceSecret)
    ));
}

#[test]
fn credential_environment_must_match_authority() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let staging_credential = service_credential(
        SERVICE_SECRET,
        DeploymentEnvironment::Staging,
        vec![ActionPolicy::AccountCreationLightV1],
    )?;

    // Act
    let result = Config::new(
        DeploymentEnvironment::Production,
        vec![staging_credential],
        public_config()?,
    );

    // Assert
    assert!(matches!(
        result,
        Err(AuthorityConfigError::EnvironmentMismatch)
    ));

    Ok(())
}

#[tokio::test]
async fn credential_rotation_accepts_overlap_then_retires_old_secret()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let old_secret = "old-production-secret-B7sT3XUqv9Jw5Ez2Kc8mP0";
    let new_secret = "new-production-secret-N8rK4YVpz6Mx2Fa3Hd7qW1";
    let policies = vec![ActionPolicy::AccountCreationLightV1];
    let overlap_url = spawn_http(authority::router(Config::new(
        DeploymentEnvironment::Production,
        vec![
            service_credential(
                old_secret,
                DeploymentEnvironment::Production,
                policies.clone(),
            )?,
            service_credential(
                new_secret,
                DeploymentEnvironment::Production,
                policies.clone(),
            )?,
        ],
        public_config()?,
    )?))
    .await?;

    // Act
    let old_overlap =
        post_challenge(&overlap_url, old_secret, "account-creation.light.v1", None).await?;
    let new_overlap =
        post_challenge(&overlap_url, new_secret, "account-creation.light.v1", None).await?;
    let retired_url = spawn_http(authority::router(Config::new(
        DeploymentEnvironment::Production,
        vec![service_credential(
            new_secret,
            DeploymentEnvironment::Production,
            policies,
        )?],
        public_config()?,
    )?))
    .await?;
    let old_retired =
        post_challenge(&retired_url, old_secret, "account-creation.light.v1", None).await?;
    let new_current =
        post_challenge(&retired_url, new_secret, "account-creation.light.v1", None).await?;

    // Assert
    assert_eq!(old_overlap.status(), reqwest::StatusCode::CREATED);
    assert_eq!(new_overlap.status(), reqwest::StatusCode::CREATED);
    assert_eq!(old_retired.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert_eq!(new_current.status(), reqwest::StatusCode::CREATED);

    Ok(())
}

#[tokio::test]
async fn credential_policy_scope_fails_closed() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let authority_url = spawn_http(authority::router(authority_config()?)).await?;

    // Act
    let response = post_challenge(
        &authority_url,
        SERVICE_SECRET,
        "account-creation.standard.v1",
        None,
    )
    .await?;

    // Assert
    assert_eq!(response.status(), reqwest::StatusCode::FORBIDDEN);
    assert_eq!(
        response.json::<Value>().await?,
        json!({ "error": "policy_not_permitted" })
    );

    Ok(())
}

#[tokio::test]
async fn repeated_authentication_failures_are_throttled() -> Result<(), Box<dyn std::error::Error>>
{
    // Arrange
    let authority_url = spawn_http(authority::router(authority_config()?)).await?;

    // Act
    let mut failed_statuses = Vec::new();
    for attempt in 0..5 {
        let response = post_challenge(
            &authority_url,
            &format!("wrong-secret-attempt-{attempt}"),
            "account-creation.light.v1",
            None,
        )
        .await?;
        failed_statuses.push(response.status());
    }
    let throttled = post_challenge(
        &authority_url,
        SERVICE_SECRET,
        "account-creation.light.v1",
        None,
    )
    .await?;

    // Assert
    assert!(
        failed_statuses
            .into_iter()
            .all(|status| status == reqwest::StatusCode::UNAUTHORIZED)
    );
    assert_eq!(throttled.status(), reqwest::StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        throttled
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok()),
        Some("60")
    );

    Ok(())
}

#[tokio::test]
async fn bounded_standard_override_is_pinned_without_mutating_policy()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let standard_credential = service_credential(
        SERVICE_SECRET,
        DeploymentEnvironment::Production,
        vec![ActionPolicy::AccountCreationStandardV1],
    )?;
    let authority_url = spawn_http(authority::router(Config::new(
        DeploymentEnvironment::Production,
        vec![standard_credential],
        public_config()?,
    )?))
    .await?;

    // Act
    let overridden = post_challenge(
        &authority_url,
        SERVICE_SECRET,
        "account-creation.standard.v1",
        Some(json!({ "expected_hashes": "8796093022208" })),
    )
    .await?
    .json::<Value>()
    .await?;
    let defaulted = post_challenge(
        &authority_url,
        SERVICE_SECRET,
        "account-creation.standard.v1",
        None,
    )
    .await?
    .json::<Value>()
    .await?;

    // Assert
    assert_eq!(
        overridden["work_requirement"]["expected_hashes"],
        "8796093022208"
    );
    assert_eq!(
        defaulted["work_requirement"]["expected_hashes"],
        "17592186044416"
    );
    assert_eq!(
        overridden["work_requirement"]["expected_hashes"],
        "8796093022208"
    );

    Ok(())
}

#[tokio::test]
async fn out_of_bounds_standard_override_is_rejected() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let authority_url = override_authority_url().await?;

    // Act
    let below_bounds = post_challenge(
        &authority_url,
        SERVICE_SECRET,
        "account-creation.standard.v1",
        Some(json!({ "expected_hashes": "1" })),
    )
    .await?;

    // Assert
    assert_eq!(below_bounds.status(), reqwest::StatusCode::BAD_REQUEST);

    Ok(())
}

#[tokio::test]
async fn unpermitted_light_override_is_rejected() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let authority_url = override_authority_url().await?;

    // Act
    let response = post_challenge(
        &authority_url,
        SERVICE_SECRET,
        "account-creation.light.v1",
        Some(json!({ "expected_hashes": "8796093022208" })),
    )
    .await?;

    // Assert
    assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);

    Ok(())
}

#[tokio::test]
async fn unknown_override_field_is_rejected() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let authority_url = override_authority_url().await?;

    // Act
    let response = post_challenge(
        &authority_url,
        SERVICE_SECRET,
        "account-creation.standard.v1",
        Some(json!({
            "expected_hashes": "8796093022208",
            "expiry_seconds": 99_999
        })),
    )
    .await?;

    // Assert
    assert_eq!(response.status(), reqwest::StatusCode::UNPROCESSABLE_ENTITY);

    Ok(())
}

#[tokio::test]
async fn authority_descriptor_publishes_complete_public_contract()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let authority_url = spawn_http(authority::router(authority_config()?)).await?;

    // Act
    let descriptor_response = reqwest::get(format!(
        "{authority_url}/.well-known/pow-gate-configuration"
    ))
    .await?;
    let descriptor = descriptor_response.json::<Value>().await?;
    let jwks = reqwest::get(format!("{authority_url}/.well-known/jwks.json"))
        .await?
        .json::<Value>()
        .await?;

    // Assert
    assert_eq!(descriptor["issuer"], "https://authority.example");
    assert_eq!(descriptor["protocol_version"], "BWG/0.1");
    assert_eq!(
        descriptor["endpoints"]["challenge_creation"],
        "https://authority.example/v0/challenges"
    );
    assert_eq!(descriptor["jwks"], jwks);
    assert_eq!(descriptor["jwks"]["keys"].as_array().map(Vec::len), Some(2));
    assert_eq!(descriptor["algorithms"]["gate_pass_jws"][0], "Ed25519");
    assert_eq!(descriptor["algorithms"]["browser_dpop_jws"][0], "ES256");
    assert_eq!(descriptor["capabilities"]["bounded_overrides"], true);
    assert_eq!(descriptor["limits"]["max_action_reference_bytes"], 256);
    assert_eq!(
        descriptor["source"]["repository"],
        "https://github.com/bright-builds-llc/bitaxe-turnstile-system"
    );
    assert_eq!(descriptor["license"]["project"], "MIT");
    assert!(
        descriptor["policies"]
            .as_array()
            .is_some_and(|policies| policies.len() == 2)
    );
    assert!(descriptor["privacy"]["url"].as_str().is_some());
    assert!(descriptor["operator_policy_url"].as_str().is_some());
    assert!(descriptor["terms_url"].as_str().is_some());
    assert!(!descriptor.to_string().contains(SERVICE_SECRET));
    assert!(!descriptor.to_string().contains(CLIENT_ID));
    serde_json::from_value::<AuthorityDescriptor>(descriptor)?;

    Ok(())
}

#[tokio::test]
async fn unknown_critical_capability_fails_closed() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let mut descriptor = published_descriptor().await?;
    descriptor["critical_capabilities"] = json!(["future_required_capability"]);
    descriptor["capabilities"]["future_required_capability"] = Value::Bool(true);

    // Act
    let result = serde_json::from_value::<AuthorityDescriptor>(descriptor);

    // Assert
    assert!(result.is_err());

    Ok(())
}

#[tokio::test]
async fn unknown_critical_policy_field_fails_closed() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let mut descriptor = published_descriptor().await?;
    descriptor["policies"][0]["critical_fields"] = json!(["future_required_policy"]);
    descriptor["policies"][0]["future_required_policy"] = Value::Bool(true);

    // Act
    let result = serde_json::from_value::<AuthorityDescriptor>(descriptor);

    // Assert
    assert!(result.is_err());

    Ok(())
}

#[tokio::test]
async fn discovery_does_not_grant_relying_service_trust() -> Result<(), Box<dyn std::error::Error>>
{
    // Arrange
    let descriptor = published_descriptor().await?;
    let trusted_authority = reference_service::TrustedAuthority::new(
        "https://separately-trusted.example",
        authority_keys()?,
    )?;
    let relying_config = reference_service::Config::new(
        "https://authority.example",
        CLIENT_ID,
        SERVICE_SECRET,
        trusted_authority,
    )?;

    // Act
    let discovered = serde_json::from_value::<AuthorityDescriptor>(descriptor)?;

    // Assert
    assert_eq!(discovered.issuer(), "https://authority.example");
    assert_eq!(
        relying_config.trusted_authority_issuer(),
        "https://separately-trusted.example"
    );
    assert_ne!(
        discovered.issuer(),
        relying_config.trusted_authority_issuer()
    );
    assert_eq!(
        relying_config.trusted_authority_key_ids(),
        vec!["authority-a", "authority-b"]
    );

    Ok(())
}

fn authority_config() -> Result<Config, Box<dyn std::error::Error>> {
    let credential = service_credential(
        SERVICE_SECRET,
        DeploymentEnvironment::Production,
        vec![ActionPolicy::AccountCreationLightV1],
    )?;
    Ok(Config::new(
        DeploymentEnvironment::Production,
        vec![credential],
        public_config()?,
    )?)
}

fn service_credential(
    secret: &str,
    environment: DeploymentEnvironment,
    policies: Vec<ActionPolicy>,
) -> Result<ServiceCredential, AuthorityConfigError> {
    ServiceCredential::new(
        CLIENT_ID,
        secret,
        environment,
        "https://relying.example".to_owned(),
        vec!["https://app.relying.example".to_owned()],
        policies,
    )
}

fn public_config() -> Result<AuthorityPublicConfig, Box<dyn std::error::Error>> {
    Ok(AuthorityPublicConfig::new(
        "https://authority.example",
        "https://authority.example",
        authority_keys()?,
        "https://authority.example/policies/operator",
        "https://authority.example/privacy",
        "https://authority.example/terms",
    )?)
}

fn authority_keys() -> Result<Vec<AuthorityJwkWire>, serde_json::Error> {
    let vectors: Value =
        serde_json::from_str(include_str!("../conformance/bwg-0.1/crypto-vectors.json"))?;
    serde_json::from_value(vectors["authority_keys"].clone())
}

async fn post_challenge(
    authority_url: &str,
    secret: &str,
    action_policy: &str,
    maybe_overrides: Option<Value>,
) -> Result<reqwest::Response, reqwest::Error> {
    let mut body = json!({
        "action_policy": action_policy,
        "action_reference": "action_secure_01",
        "claimant_key": "claimant_key_secure_01"
    });
    if let Some(overrides) = maybe_overrides {
        body["overrides"] = overrides;
    }
    reqwest::Client::new()
        .post(format!("{authority_url}/v0/challenges"))
        .header(CLIENT_ID_HEADER, CLIENT_ID)
        .bearer_auth(secret)
        .json(&body)
        .send()
        .await
}

async fn published_descriptor() -> Result<Value, Box<dyn std::error::Error>> {
    let authority_url = spawn_http(authority::router(authority_config()?)).await?;
    Ok(reqwest::get(format!(
        "{authority_url}/.well-known/pow-gate-configuration"
    ))
    .await?
    .json()
    .await?)
}

async fn override_authority_url() -> Result<String, Box<dyn std::error::Error>> {
    let credential = service_credential(
        SERVICE_SECRET,
        DeploymentEnvironment::Production,
        vec![
            ActionPolicy::AccountCreationLightV1,
            ActionPolicy::AccountCreationStandardV1,
        ],
    )?;
    Ok(spawn_http(authority::router(Config::new(
        DeploymentEnvironment::Production,
        vec![credential],
        public_config()?,
    )?))
    .await?)
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
