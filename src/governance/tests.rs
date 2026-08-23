use super::{
    GovernanceContext, GovernanceError, GovernedRecordClass, PseudonymizationKey,
    pseudonymize_record,
};

#[test]
fn pseudonymization_key_parses_a_32_byte_base64url_value() -> Result<(), Box<dyn std::error::Error>>
{
    // Arrange
    let encoded = "ERERERERERERERERERERERERERERERERERERERERERE";

    // Act
    let key = PseudonymizationKey::parse(encoded)?;

    // Assert
    assert_eq!(key.0, [0x11; 32]);

    Ok(())
}

#[test]
fn pseudonymization_key_rejects_malformed_base64url() {
    // Arrange
    let malformed = "%%%";

    // Act
    let result = PseudonymizationKey::parse(malformed);

    // Assert
    assert!(matches!(
        result,
        Err(GovernanceError::InvalidPseudonymizationKey)
    ));
}

#[test]
fn pseudonymization_key_rejects_the_wrong_decoded_length() {
    // Arrange
    let short = "ERERERERERERERERERERERERERERERERERERERER";

    // Act
    let result = PseudonymizationKey::parse(short);

    // Assert
    assert!(matches!(
        result,
        Err(GovernanceError::InvalidPseudonymizationKey)
    ));
}

#[test]
fn pseudonymization_matches_the_domain_separated_hmac_vector() {
    // Arrange
    let key = PseudonymizationKey([0x11; 32]);

    // Act
    let pseudonym = pseudonymize_record(
        &key,
        GovernanceContext::GateAuthority,
        GovernedRecordClass::AuthorityOperational,
        "challenge-123",
    );

    // Assert
    assert_eq!(
        pseudonym,
        "f036aedbb58f90bd40eceda5a8c739526d9cdf2294add9c9a48565e97057a37d"
    );
}

#[test]
fn pseudonymization_separates_context_and_record_identity() {
    // Arrange
    let key = PseudonymizationKey([0x11; 32]);

    // Act
    let authority = pseudonymize_record(
        &key,
        GovernanceContext::GateAuthority,
        GovernedRecordClass::AuthorityOperational,
        "challenge-123",
    );
    let other_context = pseudonymize_record(
        &key,
        GovernanceContext::RelyingService,
        GovernedRecordClass::AuthorityOperational,
        "challenge-123",
    );
    let other_record = pseudonymize_record(
        &key,
        GovernanceContext::GateAuthority,
        GovernedRecordClass::AuthorityOperational,
        "challenge-456",
    );

    // Assert
    assert_ne!(authority, other_context);
    assert_ne!(authority, other_record);
}
