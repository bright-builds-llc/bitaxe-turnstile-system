use bwg_core::crypto_profile::{
    AuthorityJwk, CryptoProfileError, DPOP_JWS_ALGORITHM, GATE_PASS_JWS_ALGORITHM, P256PublicJwk,
    access_token_hash, p256_jwk_thumbprint, verify_dpop, verify_gate_pass,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct CryptoVectors {
    algorithms: Algorithms,
    authority_keys: Vec<AuthorityJwk>,
    jwks_snapshots: Vec<JwksSnapshot>,
    gate_passes: Vec<GatePassVector>,
    claimant_public_jwk: P256PublicJwk,
    claimant_jkt: String,
    dpop: DpopVector,
    rotation_cases: Vec<RotationCase>,
    algorithm_negative_cases: Vec<AlgorithmNegativeCase>,
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
        .into_iter()
        .find(|snapshot| snapshot.id == "after-retirement")
        .ok_or("missing after-retirement JWKS snapshot")?;
    let trusted_keys = vectors
        .authority_keys
        .into_iter()
        .filter(|key| snapshot.accepted_kids.iter().any(|kid| kid == key.kid()))
        .collect::<Vec<_>>();
    let gate_pass = vectors
        .gate_passes
        .into_iter()
        .find(|gate_pass| gate_pass.id == "signed-by-authority-b")
        .ok_or("missing current Gate Pass vector")?;

    // Act
    let verified = verify_gate_pass(&gate_pass.compact_jws, &trusted_keys)?;

    // Assert
    assert_eq!(verified.authority_kid(), "authority-b");
    assert_eq!(verified.claimant_jkt(), gate_pass.claimant_jkt);
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
    let authority_b = vectors
        .authority_keys
        .into_iter()
        .find(|key| key.kid() == "authority-b")
        .ok_or("missing authority-b key")?;

    // Act and Assert
    for case in vectors.algorithm_negative_cases {
        let mut trusted_key = authority_b.clone();
        if let Some(key_alg_override) = case.key_alg_override {
            let mut key_json = serde_json::to_value(&trusted_key)?;
            key_json["alg"] = key_alg_override.into();
            trusted_key = serde_json::from_value(key_json)?;
        }
        let result = verify_gate_pass(&case.compact_jws, &[trusted_key]);
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

    // Act
    let jkt = p256_jwk_thumbprint(&vectors.claimant_public_jwk)?;
    let ath = access_token_hash(&vectors.dpop.access_token);
    let verified = verify_dpop(&vectors.dpop.compact_jws, &vectors.dpop.access_token)?;

    // Assert
    assert_eq!(jkt, vectors.claimant_jkt);
    assert_eq!(ath, vectors.dpop.ath);
    assert_eq!(verified.claimant_jkt(), vectors.dpop.jkt);
    assert_eq!(verified.access_token_hash(), vectors.dpop.ath);

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
        let trusted_keys = vectors
            .authority_keys
            .iter()
            .filter(|key| snapshot.accepted_kids.iter().any(|kid| kid == key.kid()))
            .cloned()
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

fn expected_algorithm_error(code: AlgorithmErrorCode) -> CryptoProfileError {
    match code {
        AlgorithmErrorCode::UnknownAlgorithm => CryptoProfileError::UnknownAlgorithm,
        AlgorithmErrorCode::SymmetricAlgorithm => CryptoProfileError::SymmetricAlgorithm,
        AlgorithmErrorCode::UnsecuredAlgorithm => CryptoProfileError::UnsecuredAlgorithm,
        AlgorithmErrorCode::DeprecatedAlgorithm => CryptoProfileError::DeprecatedAlgorithm,
        AlgorithmErrorCode::AlgorithmKeyMismatch => CryptoProfileError::AlgorithmKeyMismatch,
    }
}

fn crypto_vectors() -> Result<CryptoVectors, serde_json::Error> {
    serde_json::from_str(include_str!("../conformance/bwg-0.1/crypto-vectors.json"))
}
