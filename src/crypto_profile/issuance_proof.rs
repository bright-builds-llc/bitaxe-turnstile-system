use ring::signature;
use serde::Deserialize;

use super::{
    CompactJws, CryptoProfileError, DPOP_JWS_ALGORITHM, DpopHeaderWire, P256PublicJwk,
    decode_base64url, decode_json, p256_jwk_thumbprint, validate_algorithm,
    validate_critical_headers,
};

const ISSUANCE_PROOF_TYPE: &str = "bwg-issuance-proof+jwt";

/// Issuance Lookup values established by a valid Claimant signature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedIssuanceProof {
    claimant_jkt: String,
    proof_id: String,
    http_method: String,
    http_uri: String,
    issued_at: u64,
    challenge_id: String,
}

impl VerifiedIssuanceProof {
    /// Returns the RFC 7638 thumbprint of the proof's public JWK.
    pub fn claimant_jkt(&self) -> &str {
        &self.claimant_jkt
    }

    /// Returns the unique proof identity.
    pub fn proof_id(&self) -> &str {
        &self.proof_id
    }

    /// Returns the HTTP method covered by the proof.
    pub fn http_method(&self) -> &str {
        &self.http_method
    }

    /// Returns the public HTTP URI covered by the proof.
    pub fn http_uri(&self) -> &str {
        &self.http_uri
    }

    /// Returns the proof issue time.
    pub fn issued_at(&self) -> u64 {
        self.issued_at
    }

    /// Returns the exact Work Challenge covered by the proof.
    pub fn challenge_id(&self) -> &str {
        &self.challenge_id
    }
}

/// Verifies a dedicated Claimant proof for read-only Gate Pass Issuance Lookup.
pub fn verify_issuance_proof(
    compact_jws: &str,
) -> Result<VerifiedIssuanceProof, CryptoProfileError> {
    let compact = CompactJws::parse(compact_jws)?;
    let header: DpopHeaderWire = decode_json(compact.protected_header)?;
    validate_critical_headers(&header.critical_headers)?;
    if header.typ != ISSUANCE_PROOF_TYPE {
        return Err(CryptoProfileError::InvalidIssuanceProofType);
    }
    validate_algorithm(&header.alg, DPOP_JWS_ALGORITHM)?;

    let claimant_key = P256PublicJwk::try_from(header.jwk)?;
    let signature_bytes = decode_base64url(compact.signature)?;
    signature::UnparsedPublicKey::new(
        &signature::ECDSA_P256_SHA256_FIXED,
        claimant_key.sec1_public_key(),
    )
    .verify(compact.signing_input.as_bytes(), &signature_bytes)
    .map_err(|_| CryptoProfileError::InvalidSignature)?;

    let claims: IssuanceProofClaims = decode_json(compact.payload)?;
    claims.validate()?;
    Ok(VerifiedIssuanceProof {
        claimant_jkt: p256_jwk_thumbprint(&claimant_key),
        proof_id: claims.jti,
        http_method: claims.htm,
        http_uri: claims.htu,
        issued_at: claims.iat,
        challenge_id: claims.challenge_id,
    })
}

#[derive(Deserialize)]
struct IssuanceProofClaims {
    jti: String,
    htm: String,
    htu: String,
    iat: u64,
    challenge_id: String,
}

impl IssuanceProofClaims {
    fn validate(&self) -> Result<(), CryptoProfileError> {
        if self.jti.is_empty()
            || self.htm.is_empty()
            || self.htu.is_empty()
            || self.iat == 0
            || self.challenge_id.is_empty()
        {
            return Err(CryptoProfileError::InvalidIssuanceProofClaims);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issuance_proof_claims_require_request_and_challenge_binding() {
        // Arrange
        let claims = IssuanceProofClaims {
            jti: "proof_test_01".to_owned(),
            htm: "GET".to_owned(),
            htu: "https://authority.example/v0/challenges/challenge_test/gate-pass".to_owned(),
            iat: 1,
            challenge_id: String::new(),
        };

        // Act
        let result = claims.validate();

        // Assert
        assert_eq!(result, Err(CryptoProfileError::InvalidIssuanceProofClaims));
    }
}
