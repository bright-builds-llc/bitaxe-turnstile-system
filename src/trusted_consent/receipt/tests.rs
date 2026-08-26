use super::*;
use crate::{
    crypto_profile::{AuthorityKeySet, AuthoritySigningKey},
    trusted_consent::{
        TrustedConsentBinding, TrustedConsentBindingInput, TrustedConsentCeremony,
        TrustedConsentCeremonyId,
    },
};

const AUTHORITY_SIGNING_SEED: &str = "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A";

#[test]
fn verified_ceremony_signs_one_deterministic_bound_receipt()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let (keys, signer, ceremony, first) = receipt_fixture()?;

    // Act
    let repeated = sign_trusted_consent_receipt(&signer, "https://authority.example", &ceremony)?;
    let verified = verify_trusted_consent_receipt(
        &first,
        "https://authority.example",
        ceremony.binding(),
        keys.keys(),
        1_061,
    )?;

    // Assert
    assert_eq!(first, repeated);
    assert_eq!(verified.ceremony_id(), "ceremony_receipt_01");
    assert_eq!(verified.challenge_id(), "challenge_trusted_01");
    assert_eq!(verified.issued_at_unix_seconds(), 1_060);
    assert_eq!(verified.expires_at_unix_seconds(), 2_000);
    Ok(())
}

#[test]
fn receipt_rejects_a_different_challenge() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let (keys, _signer, _ceremony, receipt) = receipt_fixture()?;
    let mut input = binding_input();
    input.challenge_id = "challenge_different_01".to_owned();
    let wrong_binding = TrustedConsentBinding::try_from(input)?;

    // Act
    let result = verify_trusted_consent_receipt(
        &receipt,
        "https://authority.example",
        &wrong_binding,
        keys.keys(),
        1_061,
    );

    // Assert
    assert_eq!(result, Err(TrustedConsentError::InvalidReceipt));
    Ok(())
}

#[test]
fn receipt_rejects_a_different_disclosure() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let (keys, _signer, _ceremony, receipt) = receipt_fixture()?;
    let mut input = binding_input();
    input.disclosure_digest_sha256 = "Z".repeat(43);
    let wrong_binding = TrustedConsentBinding::try_from(input)?;

    // Act
    let result = verify_trusted_consent_receipt(
        &receipt,
        "https://authority.example",
        &wrong_binding,
        keys.keys(),
        1_061,
    );

    // Assert
    assert_eq!(result, Err(TrustedConsentError::InvalidReceipt));
    Ok(())
}

#[test]
fn receipt_rejects_a_different_pool_offer_set() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let (keys, _signer, _ceremony, receipt) = receipt_fixture()?;
    let mut input = binding_input();
    input.pool_offer_set_signature_sha256 = "C".repeat(43);
    let wrong_binding = TrustedConsentBinding::try_from(input)?;

    // Act
    let result = verify_trusted_consent_receipt(
        &receipt,
        "https://authority.example",
        &wrong_binding,
        keys.keys(),
        1_061,
    );

    // Assert
    assert_eq!(result, Err(TrustedConsentError::InvalidReceipt));
    Ok(())
}

#[test]
fn receipt_rejects_a_different_reason() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let (keys, _signer, _ceremony, receipt) = receipt_fixture()?;
    let mut input = binding_input();
    input.reason = "material_pool_terms".to_owned();
    let wrong_binding = TrustedConsentBinding::try_from(input)?;

    // Act
    let result = verify_trusted_consent_receipt(
        &receipt,
        "https://authority.example",
        &wrong_binding,
        keys.keys(),
        1_061,
    );

    // Assert
    assert_eq!(result, Err(TrustedConsentError::InvalidReceipt));
    Ok(())
}

#[test]
fn receipt_rejects_a_different_origin() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let (keys, _signer, _ceremony, receipt) = receipt_fixture()?;
    let mut input = binding_input();
    input.authority_origin = "https://other-authority.example".to_owned();
    let wrong_binding = TrustedConsentBinding::try_from(input)?;

    // Act
    let result = verify_trusted_consent_receipt(
        &receipt,
        "https://authority.example",
        &wrong_binding,
        keys.keys(),
        1_061,
    );

    // Assert
    assert_eq!(result, Err(TrustedConsentError::InvalidReceipt));
    Ok(())
}

#[test]
fn receipt_rejects_its_exclusive_expiry() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let (keys, _signer, ceremony, receipt) = receipt_fixture()?;

    // Act
    let result = verify_trusted_consent_receipt(
        &receipt,
        "https://authority.example",
        ceremony.binding(),
        keys.keys(),
        2_000,
    );

    // Assert
    assert_eq!(result, Err(TrustedConsentError::InvalidReceipt));
    Ok(())
}

#[test]
fn receipt_rejects_a_forged_signature() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let (keys, _signer, ceremony, receipt) = receipt_fixture()?;
    let mut forged = receipt.into_bytes();
    let last = forged.last_mut().ok_or("receipt signature is missing")?;
    *last = if *last == b'A' { b'B' } else { b'A' };
    let forged = String::from_utf8(forged)?;

    // Act
    let result = verify_trusted_consent_receipt(
        &forged,
        "https://authority.example",
        ceremony.binding(),
        keys.keys(),
        1_061,
    );

    // Assert
    assert_eq!(result, Err(TrustedConsentError::InvalidReceipt));
    Ok(())
}

fn receipt_fixture() -> Result<
    (
        AuthorityKeySet,
        AuthoritySigningKey,
        TrustedConsentCeremony,
        String,
    ),
    Box<dyn std::error::Error>,
> {
    let keys =
        AuthorityKeySet::try_from(crate::crypto_profile::test_support::authority_key_wires()?)?;
    let signer = AuthoritySigningKey::from_seed_base64url(
        "authority-a".to_owned(),
        AUTHORITY_SIGNING_SEED,
        &keys,
    )?;
    let ceremony = TrustedConsentCeremony::pending(
        TrustedConsentCeremonyId::try_from("ceremony_receipt_01".to_owned())?,
        TrustedConsentBinding::try_from(binding_input())?,
        1_000,
        1_120,
    )?
    .verify(1_060)?;
    let receipt = sign_trusted_consent_receipt(&signer, "https://authority.example", &ceremony)?;
    Ok((keys, signer, ceremony, receipt))
}

fn binding_input() -> TrustedConsentBindingInput {
    TrustedConsentBindingInput {
        challenge_id: "challenge_trusted_01".to_owned(),
        disclosure_digest_sha256: "A".repeat(43),
        pool_offer_set_signature_sha256: "B".repeat(43),
        reason: "elevated_work".to_owned(),
        authority_origin: "https://authority.example".to_owned(),
        challenge_expires_at_unix_seconds: 2_000,
    }
}
