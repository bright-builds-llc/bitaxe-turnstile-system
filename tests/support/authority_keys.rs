use bwg_core::crypto_profile::AuthorityJwkWire;
use serde_json::Value;

pub fn authority_keys() -> Result<Vec<AuthorityJwkWire>, serde_json::Error> {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../conformance/bwg-0.1/crypto-vectors.json"
    ))?;
    serde_json::from_value(vectors["authority_keys"].clone())
}
