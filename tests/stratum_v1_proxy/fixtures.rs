use std::error::Error;

use crate::stratum_hash_support::coinbase_txid;
use bitcoin::hex::FromHex as _;
use bwg_core::stratum_v1::{StratumLeaseContext, StratumV1Error};
use ring::digest;

pub(super) struct StratumJobFields<'a> {
    previous_block_hash: &'a str,
    coinbase1: &'a str,
    coinbase2: &'a str,
    version: &'a str,
    network_bits: &'a str,
    ntime: &'a str,
}

impl<'a> StratumJobFields<'a> {
    pub(super) fn new(
        previous_block_hash: &'a str,
        coinbase1: &'a str,
        coinbase2: &'a str,
        version: &'a str,
        network_bits: &'a str,
        ntime: &'a str,
    ) -> Self {
        Self {
            previous_block_hash,
            coinbase1,
            coinbase2,
            version,
            network_bits,
            ntime,
        }
    }
}

pub(super) fn worked_nonce(
    extranonce1: &str,
    extranonce2: &str,
    job: StratumJobFields<'_>,
    target: [u8; 32],
) -> Result<String, Box<dyn Error>> {
    let StratumJobFields {
        previous_block_hash,
        coinbase1,
        coinbase2,
        version,
        network_bits,
        ntime,
    } = job;
    let coinbase =
        Vec::<u8>::from_hex(&format!("{coinbase1}{extranonce1}{extranonce2}{coinbase2}"))?;
    let merkle_root = coinbase_txid(&coinbase)?;
    let mut header_prefix = Vec::with_capacity(76);
    let mut version_bytes = Vec::<u8>::from_hex(version)?;
    version_bytes.reverse();
    header_prefix.extend(version_bytes);
    let mut previous = Vec::<u8>::from_hex(previous_block_hash)?;
    for word in previous.chunks_exact_mut(4) {
        word.reverse();
    }
    header_prefix.extend(previous);
    header_prefix.extend(merkle_root);
    for value in [ntime, network_bits] {
        let mut bytes = Vec::<u8>::from_hex(value)?;
        bytes.reverse();
        header_prefix.extend(bytes);
    }
    for nonce in 0..=u32::MAX {
        let mut header = header_prefix.clone();
        header.extend(nonce.to_le_bytes());
        let mut hash = double_sha256(&header);
        hash.reverse();
        if hash <= target {
            return Ok(format!("{nonce:08x}"));
        }
    }
    Err("no worked nonce exists".into())
}

fn double_sha256(input: &[u8]) -> [u8; 32] {
    let first = digest::digest(&digest::SHA256, input);
    digest::digest(&digest::SHA256, first.as_ref())
        .as_ref()
        .try_into()
        .expect("SHA-256 output is always 32 bytes")
}

pub(super) fn hex_target(value: &str) -> Result<[u8; 32], Box<dyn Error>> {
    let bytes = (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(bytes.try_into().map_err(|_| "target must be 32 bytes")?)
}

pub(super) fn test_lease_context() -> Result<StratumLeaseContext, StratumV1Error> {
    StratumLeaseContext::new(
        "00000000-0000-4000-8000-000000000099".to_owned(),
        "boot_stratum_test".to_owned(),
        0,
        20_000,
        60_000,
    )
}
