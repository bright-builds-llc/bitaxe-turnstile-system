use bwg_core::crypto_profile::{
    AuthorityJwk, AuthorityJwkWire, CryptoProfileError, DPOP_JWS_ALGORITHM,
    GATE_PASS_JWS_ALGORITHM, P256PublicJwk, P256PublicJwkWire, access_token_hash,
    p256_jwk_thumbprint, verify_dpop, verify_gate_pass,
};
use serde::Deserialize;
use serde_json::json;

#[path = "crypto_profile/support.rs"]
mod support;
use support::*;

#[derive(Deserialize)]
struct CryptoVectors {
    algorithms: Algorithms,
    authority_keys: Vec<AuthorityJwkWire>,
    jwks_snapshots: Vec<JwksSnapshot>,
    gate_passes: Vec<GatePassVector>,
    claimant_public_jwk: P256PublicJwkWire,
    claimant_jkt: String,
    dpop: DpopVector,
    rotation_cases: Vec<RotationCase>,
    algorithm_negative_cases: Vec<AlgorithmNegativeCase>,
    critical_header_negative_cases: Vec<CriticalHeaderNegativeCase>,
    dpop_negative_cases: Vec<DpopNegativeCase>,
}

#[derive(Deserialize)]
struct Algorithms {
    gate_pass_jws: String,
    browser_dpop_jws: String,
}

#[derive(Deserialize)]
struct JwksSnapshot {
    id: String,
    accepted_kids: Vec<String>,
}

#[derive(Deserialize)]
struct GatePassVector {
    id: String,
    compact_jws: String,
    claimant_jkt: String,
    access_token_hash: String,
}

#[derive(Deserialize)]
struct AlgorithmNegativeCase {
    id: String,
    compact_jws: String,
    key_alg_override: Option<String>,
    expected_error: AlgorithmErrorCode,
}

#[derive(Deserialize)]
struct DpopVector {
    access_token: String,
    compact_jws: String,
    ath: String,
    jkt: String,
}

#[derive(Deserialize)]
struct CriticalHeaderNegativeCase {
    id: String,
    kind: CriticalHeaderKind,
    #[serde(rename = "access_token")]
    maybe_access_token: Option<String>,
    compact_jws: String,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum CriticalHeaderKind {
    GatePass,
    Dpop,
}

#[derive(Deserialize)]
struct DpopNegativeCase {
    id: String,
    access_token: String,
    compact_jws: String,
    expected_error: DpopErrorCode,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum DpopErrorCode {
    AlgorithmKeyMismatch,
    InvalidDpopClaims,
}

#[derive(Deserialize)]
struct RotationCase {
    gate_pass_id: String,
    jwks_snapshot_id: String,
    expected: RotationExpectation,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RotationExpectation {
    Valid,
    UnknownKid,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AlgorithmErrorCode {
    UnknownAlgorithm,
    SymmetricAlgorithm,
    UnsecuredAlgorithm,
    DeprecatedAlgorithm,
    AlgorithmKeyMismatch,
}

#[test]
fn rust_verifies_the_current_authority_gate_pass() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let vectors = crypto_vectors()?;
    assert_eq!(vectors.algorithms.gate_pass_jws, GATE_PASS_JWS_ALGORITHM);
    assert_eq!(vectors.algorithms.browser_dpop_jws, DPOP_JWS_ALGORITHM);
    let snapshot = vectors
        .jwks_snapshots
        .iter()
        .find(|snapshot| snapshot.id == "after-retirement")
        .ok_or("missing after-retirement JWKS snapshot")?;
    let trusted_keys = parsed_authority_keys(&vectors)?
        .into_iter()
        .filter(|key| snapshot.accepted_kids.iter().any(|kid| kid == key.kid()))
        .collect::<Vec<_>>();
    let gate_pass = vectors
        .gate_passes
        .iter()
        .find(|gate_pass| gate_pass.id == "signed-by-authority-b")
        .ok_or("missing current Gate Pass vector")?;

    // Act
    let verified = verify_gate_pass(&gate_pass.compact_jws, &trusted_keys)?;

    // Assert
    assert_eq!(verified.authority_kid(), "authority-b");
    assert_eq!(verified.claimant_jkt(), gate_pass.claimant_jkt);
    assert_eq!(verified.protected_action_type(), "account_creation");
    assert_eq!(verified.action_policy(), "account-creation.light.v1");
    assert_eq!(
        access_token_hash(&gate_pass.compact_jws),
        gate_pass.access_token_hash
    );

    Ok(())
}

#[test]
fn rust_rejects_disallowed_gate_pass_algorithms() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let vectors = crypto_vectors()?;
    let authority_b_wire = vectors
        .authority_keys
        .into_iter()
        .find(|key| key.kid() == "authority-b")
        .ok_or("missing authority-b key")?;

    // Act and Assert
    for case in vectors.algorithm_negative_cases {
        let mut trusted_key_wire = authority_b_wire.clone();
        if let Some(key_alg_override) = case.key_alg_override {
            let mut key_json = serde_json::to_value(&trusted_key_wire)?;
            key_json["alg"] = key_alg_override.into();
            trusted_key_wire = serde_json::from_value(key_json)?;
        }
        let result = AuthorityJwk::try_from(trusted_key_wire)
            .and_then(|trusted_key| verify_gate_pass(&case.compact_jws, &[trusted_key]));
        assert_eq!(
            result,
            Err(expected_algorithm_error(case.expected_error)),
            "{}",
            case.id
        );
    }

    Ok(())
}

#[test]
fn rust_verifies_dpop_key_confirmation_and_access_token_hash()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let vectors = crypto_vectors()?;
    let claimant_public_jwk = P256PublicJwk::try_from(vectors.claimant_public_jwk.clone())?;
    let authority_b = parsed_authority_keys(&vectors)?
        .into_iter()
        .find(|key| key.kid() == "authority-b")
        .ok_or("missing authority-b key")?;
    let gate_pass = vectors
        .gate_passes
        .iter()
        .find(|gate_pass| gate_pass.id == "signed-by-authority-b")
        .ok_or("missing current Gate Pass vector")?;

    // Act
    let jkt = p256_jwk_thumbprint(&claimant_public_jwk);
    let ath = access_token_hash(&vectors.dpop.access_token);
    let verified_dpop = verify_dpop(&vectors.dpop.compact_jws, &vectors.dpop.access_token)?;
    let verified_gate_pass = verify_gate_pass(&gate_pass.compact_jws, &[authority_b])?;

    // Assert
    assert_eq!(jkt, vectors.claimant_jkt);
    assert_eq!(ath, vectors.dpop.ath);
    assert_eq!(verified_dpop.claimant_jkt(), vectors.dpop.jkt);
    assert_eq!(verified_dpop.access_token_hash(), vectors.dpop.ath);
    assert_eq!(
        verified_gate_pass.claimant_jkt(),
        verified_dpop.claimant_jkt()
    );

    Ok(())
}

#[test]
fn jwks_overlap_rotation_and_retirement_are_executable() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let vectors = crypto_vectors()?;

    // Act and Assert
    for case in &vectors.rotation_cases {
        let snapshot = vectors
            .jwks_snapshots
            .iter()
            .find(|snapshot| snapshot.id == case.jwks_snapshot_id)
            .ok_or("missing JWKS snapshot")?;
        let trusted_keys = parsed_authority_keys(&vectors)?
            .into_iter()
            .filter(|key| snapshot.accepted_kids.iter().any(|kid| kid == key.kid()))
            .collect::<Vec<_>>();
        let gate_pass = vectors
            .gate_passes
            .iter()
            .find(|gate_pass| gate_pass.id == case.gate_pass_id)
            .ok_or("missing Gate Pass vector")?;
        let result = verify_gate_pass(&gate_pass.compact_jws, &trusted_keys);

        match case.expected {
            RotationExpectation::Valid => assert!(result.is_ok()),
            RotationExpectation::UnknownKid => {
                assert_eq!(result, Err(CryptoProfileError::UnknownKeyId))
            }
        }
    }

    Ok(())
}

#[test]
fn rust_rejects_unknown_critical_headers_in_both_jws_profiles()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let vectors = crypto_vectors()?;
    let authority_b = AuthorityJwk::try_from(authority_wire_by_id(&vectors, "authority-b")?)?;

    // Act and Assert
    for case in vectors.critical_header_negative_cases {
        let result = match case.kind {
            CriticalHeaderKind::GatePass => {
                verify_gate_pass(&case.compact_jws, std::slice::from_ref(&authority_b)).map(|_| ())
            }
            CriticalHeaderKind::Dpop => {
                let access_token = case.maybe_access_token.ok_or("missing DPoP access token")?;
                verify_dpop(&case.compact_jws, &access_token).map(|_| ())
            }
        };
        assert_eq!(
            result,
            Err(CryptoProfileError::UnsupportedCriticalHeader),
            "{}",
            case.id
        );
    }

    Ok(())
}

#[test]
fn rust_rejects_dpop_jwk_algorithm_mismatch() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let vectors = crypto_vectors()?;
    let case = dpop_negative_case_by_id(&vectors, "dpop-mismatched-jwk-algorithm")?;
    assert!(matches!(
        case.expected_error,
        DpopErrorCode::AlgorithmKeyMismatch
    ));

    // Act
    let result = verify_dpop(&case.compact_jws, &case.access_token);

    // Assert
    assert_eq!(result, Err(CryptoProfileError::AlgorithmKeyMismatch));

    Ok(())
}

#[test]
fn rust_rejects_invalid_required_dpop_claims() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let vectors = crypto_vectors()?;
    let case = dpop_negative_case_by_id(&vectors, "dpop-invalid-required-claims")?;
    assert!(matches!(
        case.expected_error,
        DpopErrorCode::InvalidDpopClaims
    ));

    // Act
    let result = verify_dpop(&case.compact_jws, &case.access_token);

    // Assert
    assert_eq!(result, Err(CryptoProfileError::InvalidDpopClaims));

    Ok(())
}

#[test]
fn malformed_compact_jws_is_rejected() {
    // Arrange
    let malformed = "header.payload";

    // Act
    let result = verify_gate_pass(malformed, &[]);

    // Assert
    assert_eq!(result, Err(CryptoProfileError::MalformedJws));
}

#[test]
fn invalid_base64url_is_rejected() {
    // Arrange
    let invalid = "***.e30.c2ln";

    // Act
    let result = verify_gate_pass(invalid, &[]);

    // Assert
    assert_eq!(result, Err(CryptoProfileError::InvalidBase64Url));
}

#[test]
fn invalid_protected_header_json_is_rejected() {
    // Arrange
    let invalid = "bm90LWpzb24.e30.c2ln";

    // Act
    let result = verify_gate_pass(invalid, &[]);

    // Assert
    assert_eq!(result, Err(CryptoProfileError::InvalidJson));
}

#[test]
fn wrong_gate_pass_type_is_rejected() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let vectors = crypto_vectors()?;
    let gate_pass = gate_pass_by_id(&vectors, "signed-by-authority-b")?;
    let wrong_type = replace_protected_header(
        &gate_pass.compact_jws,
        json!({ "typ": "JWT", "alg": "Ed25519", "kid": "authority-b" }),
    )?;

    // Act
    let result = verify_gate_pass(&wrong_type, &[]);

    // Assert
    assert_eq!(result, Err(CryptoProfileError::InvalidGatePassType));

    Ok(())
}

#[test]
fn wrong_dpop_type_is_rejected() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let vectors = crypto_vectors()?;
    let mut header = protected_header(&vectors.dpop.compact_jws)?;
    header["typ"] = "JWT".into();
    let wrong_type = replace_protected_header(&vectors.dpop.compact_jws, header)?;

    // Act
    let result = verify_dpop(&wrong_type, &vectors.dpop.access_token);

    // Assert
    assert_eq!(result, Err(CryptoProfileError::InvalidDpopType));

    Ok(())
}

#[test]
fn invalid_authority_jwk_metadata_is_rejected() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let vectors = crypto_vectors()?;
    let authority_b = authority_wire_by_id(&vectors, "authority-b")?;
    let mut invalid_json = serde_json::to_value(authority_b)?;
    invalid_json["kty"] = "EC".into();
    let invalid_wire: AuthorityJwkWire = serde_json::from_value(invalid_json)?;

    // Act
    let result = AuthorityJwk::try_from(invalid_wire);

    // Assert
    assert_eq!(result, Err(CryptoProfileError::InvalidAuthorityKey));

    Ok(())
}

#[test]
fn private_claimant_jwk_material_is_rejected() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let vectors = crypto_vectors()?;
    let mut invalid_json = serde_json::to_value(vectors.claimant_public_jwk)?;
    invalid_json["d"] = "private-test-material".into();
    let invalid_wire: P256PublicJwkWire = serde_json::from_value(invalid_json)?;

    // Act
    let result = P256PublicJwk::try_from(invalid_wire);

    // Assert
    assert_eq!(result, Err(CryptoProfileError::InvalidClaimantKey));

    Ok(())
}

#[test]
fn invalid_gate_pass_signature_is_rejected() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let vectors = crypto_vectors()?;
    let gate_pass = gate_pass_by_id(&vectors, "signed-by-authority-b")?;
    let authority_b = AuthorityJwk::try_from(authority_wire_by_id(&vectors, "authority-b")?)?;
    let tampered = tamper_signature(&gate_pass.compact_jws)?;

    // Act
    let result = verify_gate_pass(&tampered, &[authority_b]);

    // Assert
    assert_eq!(result, Err(CryptoProfileError::InvalidSignature));

    Ok(())
}

#[test]
fn duplicate_authority_key_identifiers_are_rejected() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let vectors = crypto_vectors()?;
    let gate_pass = gate_pass_by_id(&vectors, "signed-by-authority-b")?;
    let authority_b = AuthorityJwk::try_from(authority_wire_by_id(&vectors, "authority-b")?)?;

    // Act
    let result = verify_gate_pass(&gate_pass.compact_jws, &[authority_b.clone(), authority_b]);

    // Assert
    assert_eq!(result, Err(CryptoProfileError::AmbiguousKeyId));

    Ok(())
}

#[test]
fn dpop_access_token_hash_mismatch_is_rejected() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let vectors = crypto_vectors()?;

    // Act
    let result = verify_dpop(&vectors.dpop.compact_jws, "different-access-token");

    // Assert
    assert_eq!(result, Err(CryptoProfileError::AccessTokenHashMismatch));

    Ok(())
}

#[test]
fn invalid_signed_gate_pass_claims_are_rejected() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let vectors = crypto_vectors()?;
    let authority_a = AuthorityJwk::try_from(authority_wire_by_id(&vectors, "authority-a")?)?;
    let invalid_claims = signed_gate_pass(json!({
        "iss": "https://authority.example",
        "aud": "https://relying.example",
        "iat": 1_787_443_200_u64,
        "exp": 1_787_443_200_u64,
        "jti": "pass_invalid_claims",
        "challenge_id": "challenge_crypto_01",
        "protected_action_type": "account_creation",
        "action_reference": "action_crypto_01",
        "action_policy": "account-creation.light.v1",
        "cnf": { "jkt": vectors.claimant_jkt },
        "bwg_version": "BWG/0.1"
    }))?;

    // Act
    let result = verify_gate_pass(&invalid_claims, &[authority_a]);

    // Assert
    assert_eq!(result, Err(CryptoProfileError::InvalidGatePassClaims));

    Ok(())
}

fn expected_algorithm_error(code: AlgorithmErrorCode) -> CryptoProfileError {
    match code {
        AlgorithmErrorCode::UnknownAlgorithm => CryptoProfileError::UnknownAlgorithm,
        AlgorithmErrorCode::SymmetricAlgorithm => CryptoProfileError::SymmetricAlgorithm,
        AlgorithmErrorCode::UnsecuredAlgorithm => CryptoProfileError::UnsecuredAlgorithm,
        AlgorithmErrorCode::DeprecatedAlgorithm => CryptoProfileError::DeprecatedAlgorithm,
        AlgorithmErrorCode::AlgorithmKeyMismatch => CryptoProfileError::AlgorithmKeyMismatch,
    }
}
