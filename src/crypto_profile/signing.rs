use std::sync::Arc;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::signature::{self, KeyPair as _};
use serde::{Deserialize, Serialize};

use super::{
    AuthorityKeySet, CryptoProfileError, GATE_PASS_JWS_ALGORITHM, GATE_PASS_TYPE,
    decode_fixed_base64url,
};

/// Ed25519 Authority signer pinned to one published JWKS key.
#[derive(Clone)]
pub struct AuthoritySigningKey {
    kid: String,
    key_pair: Arc<signature::Ed25519KeyPair>,
}

impl AuthoritySigningKey {
    /// Returns the configured public key identifier selected for this signature.
    pub fn kid(&self) -> &str {
        &self.kid
    }

    /// Imports a base64url Ed25519 seed and verifies its public key against the JWKS.
    pub fn from_seed_base64url(
        kid: String,
        seed_base64url: &str,
        authority_keys: &AuthorityKeySet,
    ) -> Result<Self, CryptoProfileError> {
        let seed = decode_fixed_base64url::<32>(seed_base64url)
            .map_err(|_| CryptoProfileError::InvalidSigningKey)?;
        let key_pair = signature::Ed25519KeyPair::from_seed_unchecked(&seed)
            .map_err(|_| CryptoProfileError::InvalidSigningKey)?;
        let maybe_public_key = authority_keys
            .keys()
            .iter()
            .find(|key| key.kid == kid)
            .map(|key| key.public_key);
        if maybe_public_key.as_ref().map(|key| key.as_slice())
            != Some(key_pair.public_key().as_ref())
        {
            return Err(CryptoProfileError::InvalidSigningKey);
        }
        Ok(Self {
            kid,
            key_pair: Arc::new(key_pair),
        })
    }

    /// Signs one validated compact BWG Gate Pass.
    pub fn sign_gate_pass(
        &self,
        claims: &GatePassClaimsInput,
    ) -> Result<String, CryptoProfileError> {
        claims.validate()?;
        let header = GatePassSigningHeader {
            typ: GATE_PASS_TYPE,
            alg: GATE_PASS_JWS_ALGORITHM,
            kid: &self.kid,
        };
        let protected = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&header).map_err(|_| CryptoProfileError::SerializationFailed)?,
        );
        let payload = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(claims).map_err(|_| CryptoProfileError::SerializationFailed)?,
        );
        let signing_input = format!("{protected}.{payload}");
        let signature = self.key_pair.sign(signing_input.as_bytes());
        Ok(format!(
            "{signing_input}.{}",
            URL_SAFE_NO_PAD.encode(signature.as_ref())
        ))
    }
}

#[derive(Serialize)]
struct GatePassSigningHeader<'a> {
    typ: &'static str,
    alg: &'static str,
    kid: &'a str,
}

/// Exact claims supplied after threshold crossing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GatePassClaimsInput {
    pub iss: String,
    pub aud: String,
    pub iat: u64,
    pub exp: u64,
    pub jti: String,
    pub challenge_id: String,
    pub protected_action_type: String,
    pub action_reference: String,
    pub action_policy: String,
    pub cnf: GatePassConfirmationInput,
    pub bwg_version: String,
}

/// Immutable non-temporal Gate Pass claims fixed when a Work Challenge is issued.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct GatePassClaimsSeed {
    pub iss: String,
    pub aud: String,
    pub challenge_id: String,
    pub protected_action_type: String,
    pub action_reference: String,
    pub action_policy: String,
    pub cnf: GatePassConfirmationInput,
    pub bwg_version: String,
}

impl GatePassClaimsSeed {
    pub(crate) fn with_pass_id(self, pass_id: String) -> GatePassClaimsTemplate {
        GatePassClaimsTemplate {
            iss: self.iss,
            aud: self.aud,
            jti: pass_id,
            challenge_id: self.challenge_id,
            protected_action_type: self.protected_action_type,
            action_reference: self.action_reference,
            action_policy: self.action_policy,
            cnf: self.cnf,
            bwg_version: self.bwg_version,
        }
    }
}

/// Exact non-temporal Gate Pass claims pinned into one issuance intent.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct GatePassClaimsTemplate {
    iss: String,
    aud: String,
    jti: String,
    challenge_id: String,
    protected_action_type: String,
    action_reference: String,
    action_policy: String,
    cnf: GatePassConfirmationInput,
    bwg_version: String,
}

impl GatePassClaimsTemplate {
    pub(crate) fn with_times(self, issued_at: u64, expires_at: u64) -> GatePassClaimsInput {
        GatePassClaimsInput {
            iss: self.iss,
            aud: self.aud,
            iat: issued_at,
            exp: expires_at,
            jti: self.jti,
            challenge_id: self.challenge_id,
            protected_action_type: self.protected_action_type,
            action_reference: self.action_reference,
            action_policy: self.action_policy,
            cnf: self.cnf,
            bwg_version: self.bwg_version,
        }
    }
}

impl GatePassClaimsInput {
    fn validate(&self) -> Result<(), CryptoProfileError> {
        if self.iss.is_empty()
            || self.aud.is_empty()
            || self.jti.is_empty()
            || self.challenge_id.is_empty()
            || self.protected_action_type.is_empty()
            || self.action_reference.is_empty()
            || self.action_policy.is_empty()
            || self.cnf.jkt.is_empty()
            || self.bwg_version != "BWG/0.1"
            || self.iat >= self.exp
        {
            return Err(CryptoProfileError::InvalidGatePassClaims);
        }
        Ok(())
    }
}

/// Claimant JWK-thumbprint confirmation embedded in a Gate Pass.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct GatePassConfirmationInput {
    pub jkt: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issuance_template_pins_non_temporal_claims_before_signing() {
        // Arrange
        let seed = GatePassClaimsSeed {
            iss: "https://authority.example".to_owned(),
            aud: "https://relying.example".to_owned(),
            challenge_id: "challenge_template_01".to_owned(),
            protected_action_type: "account_creation".to_owned(),
            action_reference: "action_template_01".to_owned(),
            action_policy: "account-creation.light.v1".to_owned(),
            cnf: GatePassConfirmationInput {
                jkt: "claimant_thumbprint".to_owned(),
            },
            bwg_version: "BWG/0.1".to_owned(),
        };

        // Act
        let claims = seed
            .with_pass_id("pass_template_01".to_owned())
            .with_times(100, 220);

        // Assert
        assert_eq!(claims.iss, "https://authority.example");
        assert_eq!(claims.jti, "pass_template_01");
        assert_eq!(claims.protected_action_type, "account_creation");
        assert_eq!(claims.action_policy, "account-creation.light.v1");
        assert_eq!((claims.iat, claims.exp), (100, 220));
    }
}
