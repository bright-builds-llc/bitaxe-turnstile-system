use std::io::Error;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use bwg_core::crypto_profile::{AuthorityJwk, AuthorityJwkWire, CryptoProfileError};
use ring::signature::Ed25519KeyPair;
use serde_json::{Value, json};

use super::{CryptoVectors, DpopNegativeCase, GatePassVector};

pub(super) fn crypto_vectors() -> Result<CryptoVectors, serde_json::Error> {
    serde_json::from_str(include_str!(
        "../../conformance/bwg-0.1/crypto-vectors.json"
    ))
}

pub(super) fn authority_wire_by_id(
    vectors: &CryptoVectors,
    kid: &str,
) -> Result<AuthorityJwkWire, Box<dyn std::error::Error>> {
    vectors
        .authority_keys
        .iter()
        .find(|key| key.kid() == kid)
        .cloned()
        .ok_or_else(|| Error::other(format!("missing Authority key {kid}")).into())
}

pub(super) fn parsed_authority_keys(
    vectors: &CryptoVectors,
) -> Result<Vec<AuthorityJwk>, CryptoProfileError> {
    vectors
        .authority_keys
        .iter()
        .cloned()
        .map(AuthorityJwk::try_from)
        .collect()
}

pub(super) fn gate_pass_by_id<'a>(
    vectors: &'a CryptoVectors,
    id: &str,
) -> Result<&'a GatePassVector, Box<dyn std::error::Error>> {
    vectors
        .gate_passes
        .iter()
        .find(|gate_pass| gate_pass.id == id)
        .ok_or_else(|| Error::other(format!("missing Gate Pass {id}")).into())
}

pub(super) fn dpop_negative_case_by_id<'a>(
    vectors: &'a CryptoVectors,
    id: &str,
) -> Result<&'a DpopNegativeCase, Box<dyn std::error::Error>> {
    vectors
        .dpop_negative_cases
        .iter()
        .find(|case| case.id == id)
        .ok_or_else(|| Error::other(format!("missing DPoP case {id}")).into())
}

pub(super) fn replace_protected_header(
    compact_jws: &str,
    header: Value,
) -> Result<String, Box<dyn std::error::Error>> {
    let segments = compact_jws.split('.').collect::<Vec<_>>();
    if segments.len() != 3 {
        return Err(Error::other("fixture JWS is malformed").into());
    }
    let protected = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header)?);
    Ok(format!("{protected}.{}.{}", segments[1], segments[2]))
}

pub(super) fn protected_header(compact_jws: &str) -> Result<Value, Box<dyn std::error::Error>> {
    let Some(protected) = compact_jws.split('.').next() else {
        return Err(Error::other("fixture JWS is malformed").into());
    };
    let bytes = URL_SAFE_NO_PAD.decode(protected)?;
    Ok(serde_json::from_slice(&bytes)?)
}

pub(super) fn tamper_signature(compact_jws: &str) -> Result<String, Box<dyn std::error::Error>> {
    let segments = compact_jws.split('.').collect::<Vec<_>>();
    if segments.len() != 3 {
        return Err(Error::other("fixture JWS is malformed").into());
    }
    let mut signature = URL_SAFE_NO_PAD.decode(segments[2])?;
    let Some(first_byte) = signature.first_mut() else {
        return Err(Error::other("fixture signature is empty").into());
    };
    *first_byte ^= 1;
    Ok(format!(
        "{}.{}.{}",
        segments[0],
        segments[1],
        URL_SAFE_NO_PAD.encode(signature)
    ))
}

pub(super) fn signed_gate_pass(payload: Value) -> Result<String, Box<dyn std::error::Error>> {
    let header = json!({
        "typ": "bwg-gate-pass+jwt",
        "alg": "Ed25519",
        "kid": "authority-a"
    });
    let protected = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header)?);
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload)?);
    let signing_input = format!("{protected}.{payload}");
    let seed = URL_SAFE_NO_PAD.decode("nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A")?;
    let key_pair = Ed25519KeyPair::from_seed_unchecked(&seed)
        .map_err(|_| Error::other("RFC 8037 test seed is invalid"))?;
    let signature = URL_SAFE_NO_PAD.encode(key_pair.sign(signing_input.as_bytes()).as_ref());
    Ok(format!("{signing_input}.{signature}"))
}
