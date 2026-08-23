use ring::signature;
use serde::Deserialize;

use super::{
    CompactJws, CryptoProfileError, DPOP_JWS_ALGORITHM, DpopHeaderWire, P256PublicJwk,
    access_token_hash, decode_base64url, decode_json, p256_jwk_thumbprint, validate_algorithm,
    validate_critical_headers,
};

const DPOP_TYPE: &str = "dpop+jwt";
const ISSUANCE_PROOF_TYPE: &str = "bwg-issuance-proof+jwt";
const OUTCOME_PROOF_TYPE: &str = "bwg-outcome-proof+jwt";

/// DPoP values established by a valid Claimant signature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedDpop {
    claimant_jkt: String,
    access_token_hash: String,
    proof_id: String,
    http_method: String,
    http_uri: String,
    issued_at: u64,
}

impl VerifiedDpop {
    /// Returns the verified Claimant-key thumbprint.
    pub fn claimant_jkt(&self) -> &str {
        &self.claimant_jkt
    }
    /// Returns the verified access-token hash.
    pub fn access_token_hash(&self) -> &str {
        &self.access_token_hash
    }
    /// Returns the unique proof identity.
    pub fn proof_id(&self) -> &str {
        &self.proof_id
    }
    /// Returns the bound HTTP method.
    pub fn http_method(&self) -> &str {
        &self.http_method
    }
    /// Returns the bound HTTP URI.
    pub fn http_uri(&self) -> &str {
        &self.http_uri
    }
    /// Returns the proof issue time.
    pub fn issued_at(&self) -> u64 {
        self.issued_at
    }
}

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
    /// Returns the verified Claimant-key thumbprint.
    pub fn claimant_jkt(&self) -> &str {
        &self.claimant_jkt
    }
    /// Returns the unique proof identity.
    pub fn proof_id(&self) -> &str {
        &self.proof_id
    }
    /// Returns the bound HTTP method.
    pub fn http_method(&self) -> &str {
        &self.http_method
    }
    /// Returns the bound HTTP URI.
    pub fn http_uri(&self) -> &str {
        &self.http_uri
    }
    /// Returns the proof issue time.
    pub fn issued_at(&self) -> u64 {
        self.issued_at
    }
    /// Returns the bound Work Challenge identity.
    pub fn challenge_id(&self) -> &str {
        &self.challenge_id
    }
}

/// Outcome Lookup values established by a valid Claimant signature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedOutcomeProof {
    claimant_jkt: String,
    proof_id: String,
    http_method: String,
    http_uri: String,
    issued_at: u64,
    action_reference: String,
}

impl VerifiedOutcomeProof {
    /// Returns the verified Claimant-key thumbprint.
    pub fn claimant_jkt(&self) -> &str {
        &self.claimant_jkt
    }
    /// Returns the unique proof identity.
    pub fn proof_id(&self) -> &str {
        &self.proof_id
    }
    /// Returns the bound HTTP method.
    pub fn http_method(&self) -> &str {
        &self.http_method
    }
    /// Returns the bound HTTP URI.
    pub fn http_uri(&self) -> &str {
        &self.http_uri
    }
    /// Returns the proof issue time.
    pub fn issued_at(&self) -> u64 {
        self.issued_at
    }
    /// Returns the bound Action Reference.
    pub fn action_reference(&self) -> &str {
        &self.action_reference
    }
}

/// Verifies a Redemption DPoP proof and its exact Gate Pass hash binding.
pub fn verify_dpop(
    compact_jws: &str,
    access_token: &str,
) -> Result<VerifiedDpop, CryptoProfileError> {
    let (compact, claimant_jkt) = verify_claimant_jws(compact_jws, DPOP_TYPE)?;
    let claims: DpopClaims = decode_json(compact.payload)?;
    claims.validate()?;
    let expected_access_token_hash = access_token_hash(access_token);
    if claims.ath != expected_access_token_hash {
        return Err(CryptoProfileError::AccessTokenHashMismatch);
    }
    Ok(VerifiedDpop {
        claimant_jkt,
        access_token_hash: claims.ath,
        proof_id: claims.jti,
        http_method: claims.htm,
        http_uri: claims.htu,
        issued_at: claims.iat,
    })
}

/// Verifies a dedicated Claimant proof for read-only Issuance Lookup.
pub fn verify_issuance_proof(
    compact_jws: &str,
) -> Result<VerifiedIssuanceProof, CryptoProfileError> {
    let (compact, claimant_jkt) =
        verify_claimant_jws(compact_jws, ISSUANCE_PROOF_TYPE).map_err(map_issuance_type_error)?;
    let claims: IssuanceProofClaims = decode_json(compact.payload)?;
    claims.validate()?;
    Ok(VerifiedIssuanceProof {
        claimant_jkt,
        proof_id: claims.jti,
        http_method: claims.htm,
        http_uri: claims.htu,
        issued_at: claims.iat,
        challenge_id: claims.challenge_id,
    })
}

/// Verifies a dedicated Claimant proof for read-only Outcome Lookup.
pub fn verify_outcome_proof(compact_jws: &str) -> Result<VerifiedOutcomeProof, CryptoProfileError> {
    let (compact, claimant_jkt) =
        verify_claimant_jws(compact_jws, OUTCOME_PROOF_TYPE).map_err(map_outcome_type_error)?;
    let claims: OutcomeProofClaims = decode_json(compact.payload)?;
    claims.validate()?;
    Ok(VerifiedOutcomeProof {
        claimant_jkt,
        proof_id: claims.jti,
        http_method: claims.htm,
        http_uri: claims.htu,
        issued_at: claims.iat,
        action_reference: claims.action_reference,
    })
}

fn verify_claimant_jws<'a>(
    compact_jws: &'a str,
    expected_type: &str,
) -> Result<(CompactJws<'a>, String), CryptoProfileError> {
    let compact = CompactJws::parse(compact_jws)?;
    let header: DpopHeaderWire = decode_json(compact.protected_header)?;
    validate_critical_headers(&header.critical_headers)?;
    if header.typ != expected_type {
        return Err(CryptoProfileError::InvalidDpopType);
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
    Ok((compact, p256_jwk_thumbprint(&claimant_key)))
}

fn map_issuance_type_error(error: CryptoProfileError) -> CryptoProfileError {
    match error {
        CryptoProfileError::InvalidDpopType => CryptoProfileError::InvalidIssuanceProofType,
        error => error,
    }
}

fn map_outcome_type_error(error: CryptoProfileError) -> CryptoProfileError {
    match error {
        CryptoProfileError::InvalidDpopType => CryptoProfileError::InvalidOutcomeProofType,
        error => error,
    }
}

#[derive(Deserialize)]
struct DpopClaims {
    jti: String,
    htm: String,
    htu: String,
    iat: u64,
    ath: String,
}

impl DpopClaims {
    fn validate(&self) -> Result<(), CryptoProfileError> {
        if self.jti.is_empty()
            || self.htm.is_empty()
            || self.htu.is_empty()
            || self.iat == 0
            || self.ath.is_empty()
        {
            return Err(CryptoProfileError::InvalidDpopClaims);
        }
        Ok(())
    }
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
            || self.htm != "GET"
            || self.htu.is_empty()
            || self.iat == 0
            || self.challenge_id.is_empty()
        {
            return Err(CryptoProfileError::InvalidIssuanceProofClaims);
        }
        Ok(())
    }
}

#[derive(Deserialize)]
struct OutcomeProofClaims {
    jti: String,
    htm: String,
    htu: String,
    iat: u64,
    action_reference: String,
}

impl OutcomeProofClaims {
    fn validate(&self) -> Result<(), CryptoProfileError> {
        if self.jti.is_empty()
            || self.htm != "GET"
            || self.htu.is_empty()
            || self.iat == 0
            || self.action_reference.is_empty()
        {
            return Err(CryptoProfileError::InvalidOutcomeProofClaims);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issuance_claims_require_challenge_binding() {
        // Arrange
        let claims = IssuanceProofClaims {
            jti: "proof_01".to_owned(),
            htm: "GET".to_owned(),
            htu: "https://authority.example/lookup".to_owned(),
            iat: 1,
            challenge_id: String::new(),
        };

        // Act
        let result = claims.validate();

        // Assert
        assert_eq!(result, Err(CryptoProfileError::InvalidIssuanceProofClaims));
    }

    #[test]
    fn outcome_claims_require_action_reference_binding() {
        // Arrange
        let claims = OutcomeProofClaims {
            jti: "proof_02".to_owned(),
            htm: "GET".to_owned(),
            htu: "https://relying.example/lookup".to_owned(),
            iat: 1,
            action_reference: String::new(),
        };

        // Act
        let result = claims.validate();

        // Assert
        assert_eq!(result, Err(CryptoProfileError::InvalidOutcomeProofClaims));
    }

    #[test]
    fn lookup_claims_require_get_method() {
        // Arrange
        let claims = OutcomeProofClaims {
            jti: "proof_03".to_owned(),
            htm: "POST".to_owned(),
            htu: "https://relying.example/lookup".to_owned(),
            iat: 1,
            action_reference: "action_01".to_owned(),
        };

        // Act
        let result = claims.validate();

        // Assert
        assert_eq!(result, Err(CryptoProfileError::InvalidOutcomeProofClaims));
    }
}
