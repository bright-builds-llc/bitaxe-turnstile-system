use serde_json::Value;

use super::*;
use crate::crypto_profile::test_support::authority_key_wires;

#[test]
fn public_config_rejects_malformed_https_url() -> Result<(), serde_json::Error> {
    // Arrange
    let keys = authority_key_wires()?;

    // Act
    let result = AuthorityPublicConfig::new(
        "https://",
        "https://authority.example",
        keys,
        "https://authority.example/policies/operator",
        "https://authority.example/privacy",
        "https://authority.example/terms",
    );

    // Assert
    assert!(matches!(
        result,
        Err(AuthorityDescriptorError::InvalidPublicUrl)
    ));

    Ok(())
}

#[test]
fn public_config_rejects_empty_authority_key_set() {
    // Arrange and Act
    let result = AuthorityPublicConfig::new(
        "https://authority.example",
        "https://authority.example",
        Vec::new(),
        "https://authority.example/policies/operator",
        "https://authority.example/privacy",
        "https://authority.example/terms",
    );

    // Assert
    assert!(matches!(
        result,
        Err(AuthorityDescriptorError::InvalidAuthorityKeys)
    ));
}

#[test]
fn descriptor_rejects_algorithm_profile_mismatch() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let mut descriptor = valid_descriptor_json()?;
    descriptor["algorithms"]["gate_pass_jws"] = serde_json::json!(["RS256"]);

    // Act
    let result = serde_json::from_value::<AuthorityDescriptor>(descriptor);

    // Assert
    assert!(result.is_err());

    Ok(())
}

#[test]
fn descriptor_rejects_policy_default_mismatch() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let mut descriptor = valid_descriptor_json()?;
    descriptor["policies"][0]["default_expected_hashes"] = "1".into();

    // Act
    let result = serde_json::from_value::<AuthorityDescriptor>(descriptor);

    // Assert
    assert!(result.is_err());

    Ok(())
}

fn valid_descriptor_json() -> Result<Value, Box<dyn std::error::Error>> {
    let config = AuthorityPublicConfig::new(
        "https://authority.example",
        "https://authority.example",
        authority_key_wires()?,
        "https://authority.example/policies/operator",
        "https://authority.example/privacy",
        "https://authority.example/terms",
    )?;
    Ok(serde_json::to_value(config.descriptor())?)
}
