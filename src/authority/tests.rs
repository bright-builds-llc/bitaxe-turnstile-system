use serde_json::Value;

use super::*;
use crate::crypto_profile::AuthorityJwkWire;

const VALID_SECRET: &str = "authority-secret-P9vK2mQ7xR4tY8uN3cF6wL1zA5dH0sJ";

#[test]
fn service_credential_requires_policy_scope() {
    // Arrange and Act
    let result = ServiceCredential::new(
        "reference-service",
        VALID_SECRET,
        DeploymentEnvironment::Production,
        "https://relying.example".to_owned(),
        vec!["https://app.relying.example".to_owned()],
        Vec::new(),
    );

    // Assert
    assert!(matches!(
        result,
        Err(AuthorityConfigError::MissingPolicyScope)
    ));
}

#[test]
fn service_credential_rejects_invalid_audience() {
    // Arrange and Act
    let result = ServiceCredential::new(
        "reference-service",
        VALID_SECRET,
        DeploymentEnvironment::Production,
        "https://".to_owned(),
        vec!["https://app.relying.example".to_owned()],
        vec![ActionPolicy::AccountCreationStandardV1],
    );

    // Assert
    assert!(matches!(
        result,
        Err(AuthorityConfigError::InvalidRelyingServiceAudience)
    ));
}

#[test]
fn service_credential_rejects_invalid_origin() {
    // Arrange and Act
    let result = ServiceCredential::new(
        "reference-service",
        VALID_SECRET,
        DeploymentEnvironment::Production,
        "https://relying.example".to_owned(),
        vec!["https://app.relying.example/path".to_owned()],
        vec![ActionPolicy::AccountCreationStandardV1],
    );

    // Assert
    assert!(matches!(
        result,
        Err(AuthorityConfigError::InvalidAllowedOrigins)
    ));
}

#[test]
fn authority_config_requires_credentials() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let public = public_config()?;

    // Act
    let result = Config::new(DeploymentEnvironment::Production, Vec::new(), public);

    // Assert
    assert!(matches!(
        result,
        Err(AuthorityConfigError::MissingCredentials)
    ));

    Ok(())
}

#[test]
fn authority_config_rejects_duplicate_credential_verifier() -> Result<(), Box<dyn std::error::Error>>
{
    // Arrange
    let credential = valid_credential()?;

    // Act
    let result = Config::new(
        DeploymentEnvironment::Production,
        vec![credential.clone(), credential],
        public_config()?,
    );

    // Assert
    assert!(matches!(
        result,
        Err(AuthorityConfigError::DuplicateCredential)
    ));

    Ok(())
}

fn valid_credential() -> Result<ServiceCredential, AuthorityConfigError> {
    ServiceCredential::new(
        "reference-service",
        VALID_SECRET,
        DeploymentEnvironment::Production,
        "https://relying.example".to_owned(),
        vec!["https://app.relying.example".to_owned()],
        vec![ActionPolicy::AccountCreationStandardV1],
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
    let vectors: Value = serde_json::from_str(include_str!(
        "../../conformance/bwg-0.1/crypto-vectors.json"
    ))?;
    serde_json::from_value(vectors["authority_keys"].clone())
}
