use bwg_core::crypto_profile::AuthorityJwkWire;
use serde_json::Value;

// Integration-test binaries compile this shared support module independently.
#[allow(dead_code)]
pub const CLAIMANT_PUBLIC_JWK: &str = r#"{"kty":"EC","crv":"P-256","x":"l8tFrhx-34tV3hRICRDY9zCkDlpBhF42UQUfWVAWBFs","y":"9VE4jf_Ok_o64zbTTlcuNJajHmt6v9TDVrU0CdvGRDA"}"#;

pub fn authority_keys() -> Result<Vec<AuthorityJwkWire>, serde_json::Error> {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../conformance/bwg-0.1/crypto-vectors.json"
    ))?;
    serde_json::from_value(vectors["authority_keys"].clone())
}
