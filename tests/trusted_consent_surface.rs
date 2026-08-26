use std::{error::Error, sync::Arc};

use bwg_core::authority::{self, AuthorityApplication};
use serde_json::Value;

#[path = "support/authority_keys.rs"]
mod authority_key_support;
#[path = "support/postgres.rs"]
mod postgres_support;
#[path = "support/running_server.rs"]
mod running_server_support;
#[path = "support/trusted_consent_authority.rs"]
mod trusted_consent_authority_support;
#[path = "support/trusted_consent_verifier.rs"]
mod trusted_consent_verifier_support;
use postgres_support::PostgresTestDatabase;
use running_server_support::RunningServer;
use trusted_consent_authority_support::{authority_config, issue_elevated_challenge};
use trusted_consent_verifier_support::FakeVerifier;

#[tokio::test]
async fn authority_serves_the_trusted_surface_and_independent_challenge_reload()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let application = AuthorityApplication::connect_postgres_with_trusted_consent_verifier(
        authority_config()?,
        database.database_url(),
        Arc::new(FakeVerifier::default()),
    )
    .await?;
    let server = RunningServer::spawn(authority::router(application)).await?;
    let challenge = issue_elevated_challenge(&server.base_url).await?;
    let challenge_id = challenge["challenge_id"].as_str().ok_or("challenge ID")?;
    let client = reqwest::Client::new();

    // Act
    let surface = client
        .get(format!("{}/v0/trusted-consent", server.base_url))
        .send()
        .await?;
    let surface_cache = surface.headers()[reqwest::header::CACHE_CONTROL]
        .to_str()?
        .to_owned();
    let content_security_policy = surface.headers()["content-security-policy"]
        .to_str()?
        .to_owned();
    let surface_body = surface.error_for_status()?.text().await?;
    let script = client
        .get(format!("{}/v0/trusted-consent.js", server.base_url))
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    let styles = client
        .get(format!("{}/v0/trusted-consent.css", server.base_url))
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    let reloaded = client
        .get(format!(
            "{}/v0/challenges/{challenge_id}/trusted-consent",
            server.base_url
        ))
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;

    // Assert
    assert_eq!(surface_cache, "no-store");
    assert!(content_security_policy.contains("default-src 'none'"));
    assert!(surface_body.contains("Bitcoin Work Gate trusted confirmation"));
    assert!(surface_body.contains("https://openlinks.us/"));
    assert!(styles.contains("color-scheme: dark"));
    assert!(script.contains("navigator.credentials.create"));
    assert_eq!(reloaded["issuer"], "https://authority.example");
    assert_eq!(reloaded["challenge"], challenge);
    assert!(reloaded["jwks"]["keys"].is_array());
    server.stop();
    Ok(())
}
