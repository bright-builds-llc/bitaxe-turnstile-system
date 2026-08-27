use super::*;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::digest;
use webauthn_authenticator_rs::{prelude::WebauthnAuthenticator, softpasskey::SoftPasskey};
use webauthn_rs::prelude::CreationChallengeResponse;
use webauthn_rs_device_catalog::data::yubico::YUBICO_U2F_ROOT_CA_SERIAL_457200631_PEM;

#[test]
fn ceremony_id_requires_a_non_empty_database_compatible_suffix() {
    // Arrange
    let empty_suffix = "ceremony_".to_owned();

    // Act
    let result = TrustedConsentCeremonyId::try_from(empty_suffix);

    // Assert
    assert_eq!(result, Err(TrustedConsentError::InvalidCeremonyId));
}

#[test]
fn consent_reason_has_an_explicit_challenge_lifecycle_matrix() {
    // Arrange
    let states = [
        ChallengeLifecycleState::Issued,
        ChallengeLifecycleState::Active,
        ChallengeLifecycleState::Satisfied,
        ChallengeLifecycleState::PassIssued,
        ChallengeLifecycleState::Cancelled,
        ChallengeLifecycleState::Expired,
    ];

    // Act
    let elevated = states
        .map(|state| challenge_accepts_trusted_consent(state, &TrustedConsentReason::ElevatedWork));
    let material = states.map(|state| {
        challenge_accepts_trusted_consent(state, &TrustedConsentReason::MaterialPoolTerms)
    });

    // Assert
    assert_eq!(elevated, [true, false, false, false, false, false]);
    assert_eq!(material, [true, true, false, false, false, false]);
}

#[test]
fn binding_rejects_malformed_digests_and_non_authority_origin() {
    // Arrange
    let valid = TrustedConsentBindingInput {
        challenge_id: "challenge_trusted_01".to_owned(),
        disclosure_digest_sha256: "A".repeat(43),
        pool_offer_set_signature_sha256: "B".repeat(43),
        reason: "elevated_work".to_owned(),
        authority_origin: "https://authority.example".to_owned(),
        challenge_expires_at_unix_seconds: 2_000,
    };
    let mut malformed_digest = valid.clone();
    malformed_digest.disclosure_digest_sha256 = "not-a-digest".to_owned();
    let mut wrong_origin = valid;
    wrong_origin.authority_origin = "https://evil.example/path".to_owned();

    // Act
    let digest_result = TrustedConsentBinding::try_from(malformed_digest);
    let origin_result = TrustedConsentBinding::try_from(wrong_origin);

    // Assert
    assert_eq!(digest_result, Err(TrustedConsentError::InvalidDigest));
    assert_eq!(
        origin_result,
        Err(TrustedConsentError::InvalidAuthorityOrigin)
    );
}

#[test]
fn ceremony_can_verify_once_before_its_deadline() -> Result<(), TrustedConsentError> {
    // Arrange
    let pending = TrustedConsentCeremony::pending(
        TrustedConsentCeremonyId::try_from("ceremony_trusted_01".to_owned())?,
        binding()?,
        1_000,
        1_120,
    )?;

    // Act
    let verified = pending.clone().verify(1_060)?;
    let expired = pending.verify(1_120);
    let repeated = verified.clone().verify(1_061);

    // Assert
    assert_eq!(verified.status(), TrustedConsentCeremonyStatus::Verified);
    assert_eq!(expired, Err(TrustedConsentError::CeremonyExpired));
    assert_eq!(repeated, Err(TrustedConsentError::CeremonyAlreadyTerminal));
    Ok(())
}

#[test]
fn attested_verifier_requires_trust_and_emits_strict_registration_options()
-> Result<(), TrustedConsentError> {
    // Arrange
    let no_trust =
        AttestedWebauthnVerifier::new("authority.example", "https://authority.example", Vec::new());
    let verifier = AttestedWebauthnVerifier::new(
        "authority.example",
        "https://authority.example",
        vec![TrustedAttestationAnchorInput {
            ca_pem: include_str!("../../tests/fixtures/trusted-consent-test-root.pem").to_owned(),
            aaguid: uuid::uuid!("11111111-2222-4333-8444-555555555555"),
            description: "BWG test authenticator".to_owned(),
        }],
    )?;

    // Act
    let started = verifier.begin(
        uuid::uuid!("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
        "challenge_trusted_01",
    )?;

    // Assert
    assert!(matches!(
        no_trust,
        Err(TrustedConsentError::MissingAttestationTrust)
    ));
    assert_eq!(
        started.creation_options["publicKey"]["attestation"],
        "direct"
    );
    assert_eq!(
        started.creation_options["publicKey"]["authenticatorSelection"]["userVerification"],
        "required"
    );
    assert_eq!(
        verifier.finish(serde_json::json!({}), started.registration_state.clone()),
        Err(TrustedConsentError::InvalidWebauthnResponse)
    );
    Ok(())
}

#[test]
fn self_attested_software_authenticator_is_rejected() -> Result<(), TrustedConsentError> {
    // Arrange
    let verifier = AttestedWebauthnVerifier::new(
        "authority.example",
        "https://authority.example",
        vec![TrustedAttestationAnchorInput {
            ca_pem: include_str!("../../tests/fixtures/trusted-consent-test-root.pem").to_owned(),
            aaguid: uuid::uuid!("11111111-2222-4333-8444-555555555555"),
            description: "BWG test authenticator".to_owned(),
        }],
    )?;
    let started = verifier.begin(
        uuid::uuid!("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
        "challenge_trusted_software_01",
    )?;
    let options = serde_json::from_value::<CreationChallengeResponse>(started.creation_options)
        .map_err(|_| TrustedConsentError::InvalidWebauthnState)?;
    let mut authenticator = WebauthnAuthenticator::new(SoftPasskey::new(true));
    let response = authenticator
        .do_registration(
            url::Url::parse("https://authority.example")
                .map_err(|_| TrustedConsentError::InvalidWebauthnConfig)?,
            options,
        )
        .map_err(|_| TrustedConsentError::InvalidWebauthnResponse)?;

    // Act
    let result = verifier.finish(
        serde_json::to_value(response).map_err(|_| TrustedConsentError::InvalidWebauthnResponse)?,
        started.registration_state,
    );

    // Assert
    assert_eq!(result, Err(TrustedConsentError::WebauthnRejected));
    Ok(())
}

#[test]
fn trusted_yubikey_packed_attestation_is_accepted() -> Result<(), TrustedConsentError> {
    // Arrange
    let verifier = yubikey_verifier(uuid::uuid!("2fc0579f-8113-47ea-b116-bb5a8db9202a"))?;
    let (credential, registration_state) = yubikey_registration(&verifier)?;

    // Act
    let verified = verifier.finish(credential, registration_state)?;

    // Assert
    assert_eq!(
        verified,
        VerifiedWebauthn {
            user_present: true,
            user_verified: true,
            attestation: "trusted_non_self",
        }
    );
    Ok(())
}

#[test]
fn trusted_attestation_rejects_unapproved_authenticator_model() -> Result<(), TrustedConsentError> {
    // Arrange
    let verifier = yubikey_verifier(uuid::uuid!("11111111-2222-4333-8444-555555555555"))?;
    let (credential, registration_state) = yubikey_registration(&verifier)?;

    // Act
    let result = verifier.finish(credential, registration_state);

    // Assert
    assert_eq!(result, Err(TrustedConsentError::WebauthnRejected));
    Ok(())
}

#[test]
fn trusted_attestation_rejects_unapproved_root() -> Result<(), TrustedConsentError> {
    // Arrange
    let verifier = AttestedWebauthnVerifier::new(
        "localhost",
        "http://localhost:8080",
        vec![TrustedAttestationAnchorInput {
            ca_pem: include_str!("../../tests/fixtures/trusted-consent-test-root.pem").to_owned(),
            aaguid: uuid::uuid!("2fc0579f-8113-47ea-b116-bb5a8db9202a"),
            description: "unrelated test root".to_owned(),
        }],
    )?;
    let (credential, registration_state) = yubikey_registration(&verifier)?;

    // Act
    let result = verifier.finish(credential, registration_state);

    // Assert
    assert_eq!(result, Err(TrustedConsentError::WebauthnRejected));
    Ok(())
}

#[test]
fn trusted_attestation_rejects_wrong_ceremony_challenge() -> Result<(), TrustedConsentError> {
    // Arrange
    let verifier = yubikey_verifier(uuid::uuid!("2fc0579f-8113-47ea-b116-bb5a8db9202a"))?;
    let (mut credential, registration_state) = yubikey_registration(&verifier)?;
    mutate_client_data(&mut credential, "challenge", "wrong-challenge")?;

    // Act
    let result = verifier.finish(credential, registration_state);

    // Assert
    assert_eq!(result, Err(TrustedConsentError::WebauthnRejected));
    Ok(())
}

#[test]
fn trusted_attestation_rejects_wrong_origin() -> Result<(), TrustedConsentError> {
    // Arrange
    let verifier = yubikey_verifier(uuid::uuid!("2fc0579f-8113-47ea-b116-bb5a8db9202a"))?;
    let (mut credential, registration_state) = yubikey_registration(&verifier)?;
    mutate_client_data(&mut credential, "origin", "http://127.0.0.1:8080")?;

    // Act
    let result = verifier.finish(credential, registration_state);

    // Assert
    assert_eq!(result, Err(TrustedConsentError::WebauthnRejected));
    Ok(())
}

#[test]
fn trusted_attestation_rejects_wrong_rp_id_hash() -> Result<(), TrustedConsentError> {
    // Arrange
    let verifier = yubikey_verifier(uuid::uuid!("2fc0579f-8113-47ea-b116-bb5a8db9202a"))?;
    let (mut credential, registration_state) = yubikey_registration(&verifier)?;
    mutate_authenticator_data(&mut credential, |authenticator_data| {
        authenticator_data[0] ^= 0x01;
        Ok(())
    })?;

    // Act
    let result = verifier.finish(credential, registration_state);

    // Assert
    assert_eq!(result, Err(TrustedConsentError::WebauthnRejected));
    Ok(())
}

#[test]
fn trusted_attestation_rejects_missing_user_presence() -> Result<(), TrustedConsentError> {
    // Arrange
    let verifier = yubikey_verifier(uuid::uuid!("2fc0579f-8113-47ea-b116-bb5a8db9202a"))?;
    let (mut credential, registration_state) = yubikey_registration(&verifier)?;
    mutate_authenticator_data(&mut credential, |authenticator_data| {
        authenticator_data[32] &= !0x01;
        Ok(())
    })?;

    // Act
    let result = verifier.finish(credential, registration_state);

    // Assert
    assert_eq!(result, Err(TrustedConsentError::WebauthnRejected));
    Ok(())
}

#[test]
fn trusted_attestation_rejects_missing_user_verification() -> Result<(), TrustedConsentError> {
    // Arrange
    let verifier = yubikey_verifier(uuid::uuid!("2fc0579f-8113-47ea-b116-bb5a8db9202a"))?;
    let (mut credential, registration_state) = yubikey_registration(&verifier)?;
    mutate_authenticator_data(&mut credential, |authenticator_data| {
        authenticator_data[32] &= !0x04;
        Ok(())
    })?;

    // Act
    let result = verifier.finish(credential, registration_state);

    // Assert
    assert_eq!(result, Err(TrustedConsentError::WebauthnRejected));
    Ok(())
}

#[test]
fn trusted_attestation_rejects_bad_credential_signature() -> Result<(), TrustedConsentError> {
    // Arrange
    let verifier = yubikey_verifier(uuid::uuid!("2fc0579f-8113-47ea-b116-bb5a8db9202a"))?;
    let (mut credential, registration_state) = yubikey_registration(&verifier)?;
    mutate_attestation_object(&mut credential, |attestation_object| {
        let signature_key = attestation_object
            .windows(3)
            .position(|window| window == b"sig")
            .ok_or(TrustedConsentError::InvalidWebauthnResponse)?;
        let signature_start = signature_key
            .checked_add(5)
            .filter(|index| *index < attestation_object.len())
            .ok_or(TrustedConsentError::InvalidWebauthnResponse)?;
        attestation_object[signature_start] ^= 0x01;
        Ok(())
    })?;

    // Act
    let result = verifier.finish(credential, registration_state);

    // Assert
    assert_eq!(result, Err(TrustedConsentError::WebauthnRejected));
    Ok(())
}

#[test]
fn trusted_attestation_rejects_none_attestation() -> Result<(), TrustedConsentError> {
    // Arrange
    let verifier = yubikey_verifier(uuid::uuid!("2fc0579f-8113-47ea-b116-bb5a8db9202a"))?;
    let (mut credential, registration_state) = yubikey_registration(&verifier)?;
    mutate_attestation_object(&mut credential, |attestation_object| {
        *attestation_object = none_attestation_object(attestation_object)?;
        Ok(())
    })?;

    // Act
    let result = verifier.finish(credential, registration_state);

    // Assert
    assert_eq!(result, Err(TrustedConsentError::WebauthnRejected));
    Ok(())
}

#[test]
fn trusted_attestation_response_cannot_be_replayed_into_another_ceremony()
-> Result<(), TrustedConsentError> {
    // Arrange
    let verifier = yubikey_verifier(uuid::uuid!("2fc0579f-8113-47ea-b116-bb5a8db9202a"))?;
    let (credential, registration_state) = yubikey_registration(&verifier)?;
    verifier.finish(credential.clone(), registration_state)?;
    let replay_state = verifier
        .begin(
            uuid::uuid!("bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"),
            "challenge_trusted_yubikey_02",
        )?
        .registration_state;

    // Act
    let result = verifier.finish(credential, replay_state);

    // Assert
    assert_eq!(result, Err(TrustedConsentError::WebauthnRejected));
    Ok(())
}

fn yubikey_verifier(aaguid: Uuid) -> Result<AttestedWebauthnVerifier, TrustedConsentError> {
    AttestedWebauthnVerifier::new(
        "localhost",
        "http://localhost:8080",
        vec![TrustedAttestationAnchorInput {
            ca_pem: std::str::from_utf8(YUBICO_U2F_ROOT_CA_SERIAL_457200631_PEM)
                .map_err(|_| TrustedConsentError::InvalidAttestationTrust)?
                .to_owned(),
            aaguid,
            description: "YubiKey 5 packed-attestation fixture".to_owned(),
        }],
    )
}

fn yubikey_registration(
    verifier: &AttestedWebauthnVerifier,
) -> Result<(serde_json::Value, serde_json::Value), TrustedConsentError> {
    let mut started = verifier.begin(
        uuid::uuid!("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
        "challenge_trusted_yubikey_01",
    )?;
    started.registration_state["rs"]["challenge"] =
        serde_json::json!("fXfCQ-MWmIbcj0t3xaVzlbuZ0zPXgOE4blA065WSZco");
    let credential = serde_json::from_str(include_str!(
        "../../tests/fixtures/yubikey-packed-registration.json"
    ))
    .map_err(|_| TrustedConsentError::InvalidWebauthnResponse)?;
    Ok((credential, started.registration_state))
}

fn mutate_client_data(
    credential: &mut serde_json::Value,
    field: &str,
    value: &str,
) -> Result<(), TrustedConsentError> {
    let encoded = credential["response"]["clientDataJSON"]
        .as_str()
        .ok_or(TrustedConsentError::InvalidWebauthnResponse)?;
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| TrustedConsentError::InvalidWebauthnResponse)?;
    let mut client_data = serde_json::from_slice::<serde_json::Value>(&bytes)
        .map_err(|_| TrustedConsentError::InvalidWebauthnResponse)?;
    client_data[field] = serde_json::Value::String(value.to_owned());
    let mutated = serde_json::to_vec(&client_data)
        .map_err(|_| TrustedConsentError::InvalidWebauthnResponse)?;
    credential["response"]["clientDataJSON"] =
        serde_json::Value::String(URL_SAFE_NO_PAD.encode(mutated));
    Ok(())
}

fn mutate_authenticator_data(
    credential: &mut serde_json::Value,
    mutation: impl FnOnce(&mut [u8]) -> Result<(), TrustedConsentError>,
) -> Result<(), TrustedConsentError> {
    mutate_attestation_object(credential, |attestation_object| {
        let rp_id_hash = digest::digest(&digest::SHA256, b"localhost");
        let start = attestation_object
            .windows(rp_id_hash.as_ref().len())
            .position(|window| window == rp_id_hash.as_ref())
            .ok_or(TrustedConsentError::InvalidWebauthnResponse)?;
        let end = start
            .checked_add(37)
            .filter(|end| *end <= attestation_object.len())
            .ok_or(TrustedConsentError::InvalidWebauthnResponse)?;
        mutation(&mut attestation_object[start..end])
    })
}

fn mutate_attestation_object(
    credential: &mut serde_json::Value,
    mutation: impl FnOnce(&mut Vec<u8>) -> Result<(), TrustedConsentError>,
) -> Result<(), TrustedConsentError> {
    let encoded = credential["response"]["attestationObject"]
        .as_str()
        .ok_or(TrustedConsentError::InvalidWebauthnResponse)?;
    let mut bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| TrustedConsentError::InvalidWebauthnResponse)?;
    mutation(&mut bytes)?;
    credential["response"]["attestationObject"] =
        serde_json::Value::String(URL_SAFE_NO_PAD.encode(bytes));
    Ok(())
}

fn none_attestation_object(attestation_object: &[u8]) -> Result<Vec<u8>, TrustedConsentError> {
    let marker = attestation_object
        .windows(8)
        .position(|window| window == b"authData")
        .ok_or(TrustedConsentError::InvalidWebauthnResponse)?;
    let length_index = marker
        .checked_add(8)
        .ok_or(TrustedConsentError::InvalidWebauthnResponse)?;
    let (data_start, data_length) = match attestation_object.get(length_index..) {
        Some([0x58, length, ..]) => (length_index + 2, usize::from(*length)),
        Some([0x59, high, low, ..]) => (
            length_index + 3,
            (usize::from(*high) << 8) | usize::from(*low),
        ),
        _ => return Err(TrustedConsentError::InvalidWebauthnResponse),
    };
    let data_end = data_start
        .checked_add(data_length)
        .filter(|end| *end <= attestation_object.len())
        .ok_or(TrustedConsentError::InvalidWebauthnResponse)?;
    let mut none = b"\xa3\x63fmt\x64none\x67attStmt\xa0\x68authData".to_vec();
    if data_length <= usize::from(u8::MAX) {
        none.extend([
            0x58,
            u8::try_from(data_length).map_err(|_| TrustedConsentError::InvalidWebauthnResponse)?,
        ]);
    } else {
        let length =
            u16::try_from(data_length).map_err(|_| TrustedConsentError::InvalidWebauthnResponse)?;
        none.push(0x59);
        none.extend(length.to_be_bytes());
    }
    none.extend_from_slice(&attestation_object[data_start..data_end]);
    Ok(none)
}

fn binding() -> Result<TrustedConsentBinding, TrustedConsentError> {
    TrustedConsentBinding::try_from(TrustedConsentBindingInput {
        challenge_id: "challenge_trusted_01".to_owned(),
        disclosure_digest_sha256: "A".repeat(43),
        pool_offer_set_signature_sha256: "B".repeat(43),
        reason: "elevated_work".to_owned(),
        authority_origin: "https://authority.example".to_owned(),
        challenge_expires_at_unix_seconds: 2_000,
    })
}
