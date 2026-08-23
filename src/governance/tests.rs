use super::{
    GovernanceContext, GovernanceError, GovernedRecordClass, PassRetentionMarker,
    PseudonymizationKey, RetentionPolicy, pass_retention_floors, pseudonymize_record,
    relying_retention_floors,
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
fn relying_retention_floor_preserves_the_longer_public_lookup_window()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let policy = RetentionPolicy::hosted_default();

    // Act
    let floors = relying_retention_floors(100, 10_000_000, &[], policy)?;

    // Assert
    assert_eq!(floors.operational, 10_000_000);
    assert_eq!(floors.final_deletion, 10_000_000);

    Ok(())
}

#[test]
fn relying_retention_floor_preserves_the_longer_pass_marker_floor()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let policy = RetentionPolicy::hosted_default();
    let pass_markers = [PassRetentionMarker {
        consumed_at: 200,
        expires_at: 20_000_000,
    }];

    // Act
    let floors = relying_retention_floors(100, 200, &pass_markers, policy)?;

    // Assert
    assert_eq!(floors.operational, 20_000_000);
    assert_eq!(floors.final_deletion, 20_000_000);

    Ok(())
}

#[test]
fn relying_retention_floor_rejects_timestamp_overflow() {
    // Arrange
    let policy = RetentionPolicy::hosted_default();

    // Act
    let result = relying_retention_floors(u64::MAX, u64::MAX, &[], policy);

    // Assert
    assert!(matches!(result, Err(GovernanceError::InvalidPersistedData)));
}

#[test]
fn relying_retention_floor_uses_normal_terminal_policy_durations()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let policy = RetentionPolicy::hosted_default();

    // Act
    let floors = relying_retention_floors(100, 200, &[], policy)?;

    // Assert
    assert_eq!(floors.operational, 100 + 30 * 24 * 60 * 60);
    assert_eq!(floors.final_deletion, 100 + 90 * 24 * 60 * 60);

    Ok(())
}

#[test]
fn pass_retention_floor_uses_normal_marker_policy_durations()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let policy = RetentionPolicy::hosted_default();
    let marker = PassRetentionMarker {
        consumed_at: 100,
        expires_at: 200,
    };

    // Act
    let floors = pass_retention_floors(marker, policy)?;

    // Assert
    assert_eq!(floors.operational, 100 + 30 * 24 * 60 * 60);
    assert_eq!(floors.final_deletion, 100 + 90 * 24 * 60 * 60);

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
