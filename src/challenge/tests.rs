use serde_json::{Value, json};

use super::*;

#[test]
fn light_policy_owns_issued_terms() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let command = valid_command()?;

    // Act
    let descriptor = issue_challenge(command, "challenge_123abc".to_owned(), 1_000)?;
    let serialized = serde_json::to_value(descriptor)?;

    // Assert
    assert_eq!(serialized["action_policy"], "account-creation.light.v1");
    assert_eq!(
        serialized["work_requirement"]["expected_hashes"],
        "4398046511104"
    );
    assert_eq!(serialized["expires_at_unix_seconds"], 1_900);
    assert_eq!(serialized["protocol_version"], "BWG/0.1");

    Ok(())
}

#[test]
fn unknown_action_policy_is_rejected() {
    // Arrange
    let policy_id = "account-creation.light.v0";

    // Act
    let result = ActionPolicy::parse(policy_id);

    // Assert
    assert_eq!(result, Err(ChallengeError::UnknownActionPolicy));
}

#[test]
fn standard_policy_owns_default_work() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let mut command = valid_command()?;
    command.action_policy = ActionPolicy::AccountCreationStandardV1;

    // Act
    let descriptor = issue_challenge(command, "challenge_123abc".to_owned(), 1_000)?;
    let serialized = serde_json::to_value(descriptor)?;

    // Assert
    assert_eq!(serialized["action_policy"], "account-creation.standard.v1");
    assert_eq!(
        serialized["work_requirement"]["expected_hashes"],
        "17592186044416"
    );

    Ok(())
}

#[test]
fn standard_policy_accepts_inclusive_override_boundaries() -> Result<(), Box<dyn std::error::Error>>
{
    // Arrange
    let overrides = ["8796093022208", "35184372088832"];

    // Act
    let results = overrides.map(|value| {
        let mut command = valid_command()?;
        command.action_policy = ActionPolicy::AccountCreationStandardV1;
        command.maybe_work_requirement_override =
            Some(WorkRequirementOverride::expected_hashes(value.to_owned())?);
        issue_challenge(command, "challenge_123abc".to_owned(), 1_000)
    });

    // Assert
    assert!(results.into_iter().all(|result| result.is_ok()));

    Ok(())
}

#[test]
fn light_policy_rejects_work_override() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let mut command = valid_command()?;
    command.maybe_work_requirement_override = Some(WorkRequirementOverride::expected_hashes(
        "8796093022208".to_owned(),
    )?);

    // Act
    let result = issue_challenge(command, "challenge_123abc".to_owned(), 1_000);

    // Assert
    assert_eq!(result, Err(ChallengeError::OverrideNotPermitted));

    Ok(())
}

#[test]
fn action_reference_enforces_bounded_non_empty_input() {
    // Arrange
    let maximum = "a".repeat(MAX_ACTION_REFERENCE_LENGTH);
    let over_maximum = "a".repeat(MAX_ACTION_REFERENCE_LENGTH + 1);

    // Act
    let empty_result = ActionReference::try_from(String::new());
    let maximum_result = ActionReference::try_from(maximum);
    let over_maximum_result = ActionReference::try_from(over_maximum);

    // Assert
    assert_eq!(empty_result, Err(ChallengeError::InvalidActionReference));
    assert!(maximum_result.is_ok());
    assert_eq!(
        over_maximum_result,
        Err(ChallengeError::InvalidActionReference)
    );
}

#[test]
fn claimant_key_enforces_bounded_non_empty_input() {
    // Arrange
    let maximum = "k".repeat(MAX_CLAIMANT_KEY_LENGTH);
    let over_maximum = "k".repeat(MAX_CLAIMANT_KEY_LENGTH + 1);

    // Act
    let empty_result = ClaimantKey::try_from(String::new());
    let maximum_result = ClaimantKey::try_from(maximum);
    let over_maximum_result = ClaimantKey::try_from(over_maximum);

    // Assert
    assert_eq!(empty_result, Err(ChallengeError::InvalidClaimantKey));
    assert!(maximum_result.is_ok());
    assert_eq!(over_maximum_result, Err(ChallengeError::InvalidClaimantKey));
}

#[test]
fn challenge_id_requires_the_opaque_server_format() {
    // Arrange
    let invalid_values = ["123abc", "challenge_", "challenge_not-opaque"];

    // Act
    let results = invalid_values.map(|value| ChallengeId::try_from(value.to_owned()));

    // Assert
    assert!(
        results
            .into_iter()
            .all(|result| result == Err(ChallengeError::InvalidChallengeId))
    );
}

#[test]
fn expiry_overflow_is_rejected() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let command = valid_command()?;

    // Act
    let result = issue_challenge(command, "challenge_123abc".to_owned(), u64::MAX);

    // Assert
    assert_eq!(result, Err(ChallengeError::ExpiryOverflow));

    Ok(())
}

#[test]
fn descriptor_deserialization_revalidates_newtypes() {
    // Arrange
    let mut descriptor = valid_descriptor_json();
    descriptor["action_reference"] = Value::String(String::new());

    // Act
    let result = serde_json::from_value::<WorkChallengeDescriptor>(descriptor);

    // Assert
    assert!(result.is_err());
}

#[test]
fn descriptor_deserialization_rejects_policy_work_mismatch() {
    // Arrange
    let mut descriptor = valid_descriptor_json();
    descriptor["work_requirement"]["expected_hashes"] = Value::String("1".to_owned());

    // Act
    let result = serde_json::from_value::<WorkChallengeDescriptor>(descriptor);

    // Assert
    assert!(result.is_err());
}

#[test]
fn descriptor_deserialization_rejects_unknown_protocol_version() {
    // Arrange
    let mut descriptor = valid_descriptor_json();
    descriptor["protocol_version"] = Value::String("BWG/1".to_owned());

    // Act
    let result = serde_json::from_value::<WorkChallengeDescriptor>(descriptor);

    // Assert
    assert!(result.is_err());
}

#[test]
fn work_override_requires_canonical_non_zero_decimal() {
    // Arrange
    let invalid_values = ["", "0", "01", "1.0", "-1", "abc"];

    // Act
    let results =
        invalid_values.map(|value| WorkRequirementOverride::expected_hashes(value.to_owned()));

    // Assert
    assert!(
        results
            .into_iter()
            .all(|result| result == Err(ChallengeError::InvalidExpectedHashes))
    );
}

fn valid_command() -> Result<IssueChallengeCommand, ChallengeError> {
    Ok(IssueChallengeCommand {
        action_policy: ActionPolicy::AccountCreationLightV1,
        action_reference: ActionReference::try_from("action_123abc".to_owned())?,
        claimant_key: ClaimantKey::try_from("claimant_key_123abc".to_owned())?,
        relying_service_audience: RelyingServiceAudience::try_from(
            "https://relying.example".to_owned(),
        )?,
        allowed_origins: AllowedOrigins::try_from(vec!["https://app.relying.example".to_owned()])?,
        maybe_work_requirement_override: None,
    })
}

fn valid_descriptor_json() -> Value {
    json!({
        "challenge_id": "challenge_123abc",
        "action_policy": "account-creation.light.v1",
        "action_reference": "action_123abc",
        "claimant_key": "claimant_key_123abc",
        "relying_service_audience": "https://relying.example",
        "allowed_origins": ["https://app.relying.example"],
        "work_requirement": { "expected_hashes": "4398046511104" },
        "expires_at_unix_seconds": 1_900,
        "protocol_version": "BWG/0.1"
    })
}
