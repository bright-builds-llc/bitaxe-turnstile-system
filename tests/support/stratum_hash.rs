use std::error::Error;

use ring::digest;

/// Hashes the coinbase exactly as ESP-Miner does: dSHA256 of coinb1, extranonce1,
/// extranonce2 and coinb2 as sent. A witness-serialized coinbase would give the
/// wtxid's input instead of the txid's, so the merkle root a pool checks would differ.
pub fn coinbase_txid(coinbase: &[u8]) -> Result<[u8; 32], Box<dyn Error>> {
    let witness_marker =
        coinbase.get(4) == Some(&0) && coinbase.get(5).is_some_and(|flag| *flag != 0);
    if witness_marker {
        return Err(
            "notify's coinbase is witness-serialized; Stratum miners hash it as sent".into(),
        );
    }
    Ok(double_sha256(coinbase))
}

fn double_sha256(input: &[u8]) -> [u8; 32] {
    let first = digest::digest(&digest::SHA256, input);
    digest::digest(&digest::SHA256, first.as_ref())
        .as_ref()
        .try_into()
        .expect("SHA-256 output is always 32 bytes")
}
