use super::*;

#[test]
fn generated_secret_is_a_valid_256_bit_token() -> Result<(), ServiceAuthError> {
    // Arrange and Act
    let secret = ServiceSecret::generate()?;

    // Assert
    assert_eq!(secret.expose_secret().len(), 43);
    assert!(ServiceSecret::try_from(secret.expose_secret().to_owned()).is_ok());

    Ok(())
}

#[test]
fn repeated_or_low_diversity_secret_is_rejected() {
    // Arrange
    let repeated = "a".repeat(43);
    let low_diversity = "abcd".repeat(11);

    // Act
    let repeated_result = ServiceSecret::try_from(repeated);
    let low_diversity_result = ServiceSecret::try_from(low_diversity);

    // Assert
    assert_eq!(
        repeated_result.err(),
        Some(ServiceAuthError::InvalidServiceSecret)
    );
    assert_eq!(
        low_diversity_result.err(),
        Some(ServiceAuthError::InvalidServiceSecret)
    );
}

#[test]
fn malformed_client_identifier_is_rejected() {
    // Arrange
    let invalid = ["", "client id", "client/id"];

    // Act
    let results = invalid.map(|value| ServiceClientId::try_from(value.to_owned()));

    // Assert
    assert!(results.into_iter().all(|result| result.is_err()));
}
