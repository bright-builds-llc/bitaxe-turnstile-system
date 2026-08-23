use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use bwg_core::crypto_profile::{CryptoProfileError, verify_issuance_proof, verify_outcome_proof};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct LookupProofVectors {
    profile: String,
    algorithm: String,
    issuance_proof: ProofVector,
    outcome_proof: ProofVector,
    negative_cases: Vec<NegativeCase>,
}

#[test]
fn rust_executes_lookup_proof_negative_vectors() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let vectors: LookupProofVectors = serde_json::from_str(include_str!(
        "../conformance/bwg-0.1/lookup-proof-vectors.json"
    ))?;
    let mut segments = vectors
        .issuance_proof
        .compact_jws
        .split('.')
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut header: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(&segments[0])?)?;
    header["typ"] = Value::String("bwg-outcome-proof+jwt".to_owned());
    segments[0] = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header)?);
    let wrong_type = segments.join(".");
    let mut invalid_signature = vectors.outcome_proof.compact_jws.clone();
    let signature_start = invalid_signature
        .rfind('.')
        .ok_or("compact proof needs a signature")?
        + 1;
    invalid_signature.replace_range(signature_start..=signature_start, "A");

    // Act
    let wrong_type_result = verify_issuance_proof(&wrong_type);
    let signature_result = verify_outcome_proof(&invalid_signature);

    // Assert
    assert_eq!(
        wrong_type_result,
        Err(CryptoProfileError::InvalidIssuanceProofType)
    );
    assert_eq!(signature_result, Err(CryptoProfileError::InvalidSignature));

    Ok(())
}

#[derive(Deserialize)]
struct ProofVector {
    compact_jws: String,
}

#[derive(Deserialize)]
struct NegativeCase {
    id: String,
    expected_error: String,
}

#[test]
fn rust_verifies_portable_lookup_proof_vectors() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let vectors: LookupProofVectors = serde_json::from_str(include_str!(
        "../conformance/bwg-0.1/lookup-proof-vectors.json"
    ))?;

    // Act
    let issuance = verify_issuance_proof(&vectors.issuance_proof.compact_jws)?;
    let outcome = verify_outcome_proof(&vectors.outcome_proof.compact_jws)?;

    // Assert
    assert_eq!(vectors.profile, "BWG/0.1");
    assert_eq!(vectors.algorithm, "ES256");
    assert_eq!(issuance.proof_id(), "proof_fixture_issuance_01");
    assert_eq!(issuance.challenge_id(), "challenge_fixture_01");
    assert_eq!(outcome.proof_id(), "proof_fixture_outcome_01");
    assert_eq!(outcome.action_reference(), "action_fixture_01");
    assert_eq!(issuance.claimant_jkt(), outcome.claimant_jkt());
    assert_eq!(vectors.negative_cases.len(), 4);
    assert!(
        vectors
            .negative_cases
            .iter()
            .all(|case| !case.id.is_empty() && !case.expected_error.is_empty())
    );

    Ok(())
}
