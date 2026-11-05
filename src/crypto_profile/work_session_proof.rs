use serde::Deserialize;

use super::{CryptoProfileError, claimant_proof::verify_claimant_jws, decode_json};

/// Protected type of the Claimant proof for Work Session control (ADR-0106).
pub const WORK_SESSION_PROOF_TYPE: &str = "bwg-work-session-proof+jwt";

/// Work Session control values established by a valid Claimant signature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedWorkSessionProof {
    claimant_jkt: String,
    proof_id: String,
    http_uri: String,
    issued_at: u64,
    challenge_id: String,
    request_sha256: String,
}

impl VerifiedWorkSessionProof {
    /// Returns the verified Claimant-key thumbprint.
    pub fn claimant_jkt(&self) -> &str {
        &self.claimant_jkt
    }
    /// Returns the single-use proof identity.
    pub fn proof_id(&self) -> &str {
        &self.proof_id
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
    /// Returns the base64url SHA-256 of the exact request body.
    pub fn request_sha256(&self) -> &str {
        &self.request_sha256
    }
}

/// Verifies a Claimant proof for one POST Work Session control request.
pub fn verify_work_session_proof(
    compact_jws: &str,
) -> Result<VerifiedWorkSessionProof, CryptoProfileError> {
    let (compact, claimant_jkt) = verify_claimant_jws(compact_jws, WORK_SESSION_PROOF_TYPE)
        .map_err(|error| match error {
            CryptoProfileError::InvalidDpopType => CryptoProfileError::InvalidWorkSessionProofType,
            error => error,
        })?;
    let claims: WorkSessionProofClaims = decode_json(compact.payload)?;
    claims.validate()?;
    Ok(VerifiedWorkSessionProof {
        claimant_jkt,
        proof_id: claims.jti,
        http_uri: claims.htu,
        issued_at: claims.iat,
        challenge_id: claims.challenge_id,
        request_sha256: claims.request_sha256,
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkSessionProofClaims {
    jti: String,
    htm: String,
    htu: String,
    iat: u64,
    challenge_id: String,
    request_sha256: String,
}

impl WorkSessionProofClaims {
    fn validate(&self) -> Result<(), CryptoProfileError> {
        if self.jti.is_empty()
            || self.jti.len() > 128
            || self.htm != "POST"
            || self.htu.is_empty()
            || self.iat == 0
            || self.challenge_id.is_empty()
            || self.request_sha256.len() != 43
        {
            return Err(CryptoProfileError::InvalidWorkSessionProofClaims);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claims() -> WorkSessionProofClaims {
        WorkSessionProofClaims {
            jti: "proof_01".to_owned(),
            htm: "POST".to_owned(),
            htu: "https://authority.example/v0/challenges/challenge_01/work-session/start"
                .to_owned(),
            iat: 1,
            challenge_id: "challenge_01".to_owned(),
            request_sha256: "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU".to_owned(),
        }
    }

    #[test]
    fn work_session_claims_require_post() {
        // Arrange
        let claims = WorkSessionProofClaims {
            htm: "GET".to_owned(),
            ..claims()
        };

        // Act
        let result = claims.validate();

        // Assert
        assert_eq!(
            result,
            Err(CryptoProfileError::InvalidWorkSessionProofClaims)
        );
    }

    #[test]
    fn work_session_claims_require_a_body_digest() {
        // Arrange
        let claims = WorkSessionProofClaims {
            request_sha256: String::new(),
            ..claims()
        };

        // Act
        let result = claims.validate();

        // Assert
        assert_eq!(
            result,
            Err(CryptoProfileError::InvalidWorkSessionProofClaims)
        );
    }
}
