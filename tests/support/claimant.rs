use std::{error::Error, io::Error as IoError, sync::Arc};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use bwg_core::crypto_profile::{
    P256PublicJwk, P256PublicJwkWire, access_token_hash, p256_jwk_thumbprint,
};
use ring::{
    rand::SystemRandom,
    signature::{self, KeyPair as _},
};
use serde_json::json;

pub struct Claimant {
    key_pair: Arc<signature::EcdsaKeyPair>,
    public_jwk: serde_json::Value,
    pub public_jwk_json: String,
}

impl Claimant {
    pub fn generate() -> Result<Self, Box<dyn Error>> {
        let random = SystemRandom::new();
        let pkcs8 = signature::EcdsaKeyPair::generate_pkcs8(
            &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
            &random,
        )
        .map_err(|_| IoError::other("failed to generate Claimant key"))?;
        let key_pair = signature::EcdsaKeyPair::from_pkcs8(
            &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
            pkcs8.as_ref(),
            &random,
        )
        .map_err(|_| IoError::other("failed to import Claimant key"))?;
        let public_key = key_pair.public_key().as_ref();
        let x = URL_SAFE_NO_PAD.encode(&public_key[1..33]);
        let y = URL_SAFE_NO_PAD.encode(&public_key[33..65]);
        let public_jwk = json!({
            "kty": "EC",
            "crv": "P-256",
            "x": x,
            "y": y,
            "alg": "ES256"
        });
        Ok(Self {
            key_pair: Arc::new(key_pair),
            public_jwk_json: serde_json::to_string(&public_jwk)?,
            public_jwk,
        })
    }

    // Each integration-test binary compiles this shared helper independently.
    #[allow(dead_code)]
    pub fn jkt(&self) -> Result<String, Box<dyn Error>> {
        let wire = serde_json::from_value::<P256PublicJwkWire>(self.public_jwk.clone())?;
        let key = P256PublicJwk::try_from(wire)?;
        Ok(p256_jwk_thumbprint(&key))
    }

    #[allow(dead_code)]
    pub fn sign_dpop(
        &self,
        gate_pass: &str,
        redemption_url: &str,
        proof_id: &str,
        issued_at: u64,
    ) -> Result<String, Box<dyn Error>> {
        self.sign(
            "dpop+jwt",
            json!({
                "jti": proof_id,
                "htm": "POST",
                "htu": redemption_url,
                "iat": issued_at,
                "ath": access_token_hash(gate_pass)
            }),
        )
    }

    pub fn sign_issuance_proof(
        &self,
        lookup_url: &str,
        challenge_id: &str,
        proof_id: &str,
        issued_at: u64,
    ) -> Result<String, Box<dyn Error>> {
        self.sign(
            "bwg-issuance-proof+jwt",
            json!({
                "jti": proof_id,
                "htm": "GET",
                "htu": lookup_url,
                "iat": issued_at,
                "challenge_id": challenge_id
            }),
        )
    }

    fn sign(&self, proof_type: &str, payload: serde_json::Value) -> Result<String, Box<dyn Error>> {
        let protected = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&json!({
            "typ": proof_type,
            "alg": "ES256",
            "jwk": self.public_jwk
        }))?);
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload)?);
        let signing_input = format!("{protected}.{payload}");
        let signature = self
            .key_pair
            .sign(&SystemRandom::new(), signing_input.as_bytes())
            .map_err(|_| IoError::other("failed to sign issuance proof"))?;
        Ok(format!(
            "{signing_input}.{}",
            URL_SAFE_NO_PAD.encode(signature.as_ref())
        ))
    }
}
