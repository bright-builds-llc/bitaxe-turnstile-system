use std::sync::Arc;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::signature::{self, KeyPair as _};
use serde::Serialize;

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
    pub action_reference: String,
    pub cnf: GatePassConfirmationInput,
    pub bwg_version: String,
}

impl GatePassClaimsInput {
    fn validate(&self) -> Result<(), CryptoProfileError> {
        if self.iss.is_empty()
            || self.aud.is_empty()
            || self.jti.is_empty()
            || self.challenge_id.is_empty()
            || self.action_reference.is_empty()
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GatePassConfirmationInput {
    pub jkt: String,
}
