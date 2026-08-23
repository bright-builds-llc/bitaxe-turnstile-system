use super::*;
use crate::crypto_profile::test_support::authority_key_wires;

const VALID_SECRET: &str = "reference-secret-P9vK2mQ7xR4tY8uN3cF6wL1zA5dH0sJ";

#[test]
fn trusted_authority_rejects_invalid_issuer() -> Result<(), serde_json::Error> {
    // Arrange
    let keys = authority_key_wires()?;

    // Act
    let result = TrustedAuthority::new("http://authority.example", keys);

    // Assert
    assert!(matches!(
        result,
        Err(ReferenceConfigError::InvalidTrustedIssuer)
    ));

    Ok(())
}

#[test]
fn trusted_authority_rejects_empty_key_set() {
    // Arrange and Act
    let result = TrustedAuthority::new("https://authority.example", Vec::new());

    // Assert
    assert!(matches!(
        result,
        Err(ReferenceConfigError::InvalidTrustedKeys)
    ));
}

#[test]
fn trusted_authority_rejects_duplicate_key_ids() -> Result<(), serde_json::Error> {
    // Arrange
    let keys = authority_key_wires()?;

    // Act
    let result = TrustedAuthority::new(
        "https://authority.example",
        vec![keys[0].clone(), keys[0].clone()],
    );

    // Assert
    assert!(matches!(
        result,
        Err(ReferenceConfigError::InvalidTrustedKeys)
    ));

    Ok(())
}

#[test]
fn reference_config_rejects_insecure_remote_authority_endpoint()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let trusted = trusted_authority()?;

    // Act
    let result = Config::new(
        "http://authority.example",
        "reference-service",
        VALID_SECRET,
        trusted,
    );

    // Assert
    assert!(matches!(
        result,
        Err(ReferenceConfigError::InvalidAuthorityEndpoint)
    ));

    Ok(())
}

#[test]
fn reference_config_rejects_invalid_client_identifier() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let trusted = trusted_authority()?;

    // Act
    let result = Config::new(
        "https://authority.example",
        "invalid client",
        VALID_SECRET,
        trusted,
    );

    // Assert
    assert!(matches!(result, Err(ReferenceConfigError::InvalidClientId)));

    Ok(())
}

#[test]
fn reference_config_rejects_weak_service_secret() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let trusted = trusted_authority()?;

    // Act
    let result = Config::new(
        "https://authority.example",
        "reference-service",
        "a".repeat(43),
        trusted,
    );

    // Assert
    assert!(matches!(
        result,
        Err(ReferenceConfigError::InvalidServiceSecret)
    ));

    Ok(())
}

fn trusted_authority() -> Result<TrustedAuthority, Box<dyn std::error::Error>> {
    Ok(TrustedAuthority::new(
        "https://authority.example",
        authority_key_wires()?,
    )?)
}
