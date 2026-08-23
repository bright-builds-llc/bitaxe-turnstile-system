use super::{GovernanceContext, GovernedRecordClass, PseudonymizationKey, pseudonymize_record};

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
