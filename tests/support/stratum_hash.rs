use std::error::Error;

use bitcoin::hashes::Hash as _;
use ring::digest;

pub fn coinbase_txid(coinbase: &[u8]) -> Result<[u8; 32], Box<dyn Error>> {
    let has_witness = coinbase.get(4) == Some(&0) && coinbase.get(5).is_some_and(|flag| *flag != 0);
    if !has_witness {
        return Ok(double_sha256(coinbase));
    }
    let transaction = bitcoin::consensus::deserialize::<bitcoin::Transaction>(coinbase)?;
    Ok(transaction.compute_txid().to_raw_hash().to_byte_array())
}

fn double_sha256(input: &[u8]) -> [u8; 32] {
    let first = digest::digest(&digest::SHA256, input);
    digest::digest(&digest::SHA256, first.as_ref())
        .as_ref()
        .try_into()
        .expect("SHA-256 output is always 32 bytes")
}
