use serde_json::Value;

use super::AuthorityJwkWire;

pub(crate) fn authority_key_wires() -> Result<Vec<AuthorityJwkWire>, serde_json::Error> {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../conformance/bwg-0.1/crypto-vectors.json"
    ))?;
    serde_json::from_value(vectors["authority_keys"].clone())
}
