use bitcoin::hashes::Hash as _;
use ring::digest;
use serde_json::Value;

use super::{StratumJob, StratumV1Error};
use crate::progress::NetworkTargetOutcome;

fn difficulty_one_target() -> [u8; 32] {
    let mut target = [0_u8; 32];
    target[4] = 0xff;
    target[5] = 0xff;
    target
}

pub(super) fn target_for_difficulty(difficulty: &Value) -> Result<[u8; 32], StratumV1Error> {
    let (numerator, denominator) = decimal_ratio(difficulty)?;
    scale_target(difficulty_one_target(), denominator, numerator)
}

fn decimal_ratio(value: &Value) -> Result<(u64, u64), StratumV1Error> {
    let text = value
        .as_number()
        .map(ToString::to_string)
        .ok_or(StratumV1Error::UnsupportedDifficulty)?;
    let (mantissa, exponent) = text
        .find(['e', 'E'])
        .map_or((text.as_str(), 0_i32), |index| {
            let (mantissa, exponent) = text.split_at(index);
            (mantissa, exponent[1..].parse::<i32>().unwrap_or(i32::MIN))
        });
    if !(-18..=18).contains(&exponent) {
        return Err(StratumV1Error::UnsupportedDifficulty);
    }
    let (whole, maybe_fraction) = mantissa
        .split_once('.')
        .map_or((mantissa, None), |(whole, fraction)| {
            (whole, Some(fraction))
        });
    if whole.starts_with('-') || maybe_fraction.is_some_and(|fraction| fraction.len() > 18) {
        return Err(StratumV1Error::UnsupportedDifficulty);
    }
    let fraction = maybe_fraction.unwrap_or("");
    let mut denominator = 10_u64
        .checked_pow(
            u32::try_from(fraction.len()).map_err(|_| StratumV1Error::UnsupportedDifficulty)?,
        )
        .ok_or(StratumV1Error::UnsupportedDifficulty)?;
    let mut numerator = whole
        .parse::<u64>()
        .ok()
        .and_then(|whole| whole.checked_mul(denominator))
        .and_then(|whole| fraction.parse::<u64>().unwrap_or(0).checked_add(whole))
        .filter(|numerator| *numerator > 0)
        .ok_or(StratumV1Error::UnsupportedDifficulty)?;
    if exponent > 0 {
        numerator = numerator
            .checked_mul(
                10_u64
                    .checked_pow(exponent.unsigned_abs())
                    .ok_or(StratumV1Error::UnsupportedDifficulty)?,
            )
            .ok_or(StratumV1Error::UnsupportedDifficulty)?;
    } else if exponent < 0 {
        denominator = denominator
            .checked_mul(
                10_u64
                    .checked_pow(exponent.unsigned_abs())
                    .ok_or(StratumV1Error::UnsupportedDifficulty)?,
            )
            .ok_or(StratumV1Error::UnsupportedDifficulty)?;
    }
    let divisor = greatest_common_divisor(numerator, denominator);
    Ok((numerator / divisor, denominator / divisor))
}

fn greatest_common_divisor(mut left: u64, mut right: u64) -> u64 {
    while right != 0 {
        (left, right) = (right, left % right);
    }
    left
}

fn scale_target(
    target: [u8; 32],
    multiplier: u64,
    divisor: u64,
) -> Result<[u8; 32], StratumV1Error> {
    if divisor == 0 {
        return Err(StratumV1Error::UnsupportedDifficulty);
    }
    let mut product = [0_u8; 40];
    let mut carry = 0_u128;
    for (index, byte) in target.into_iter().enumerate().rev() {
        let value = u128::from(byte) * u128::from(multiplier) + carry;
        product[index + 8] = value as u8;
        carry = value >> 8;
    }
    for byte in product[..8].iter_mut().rev() {
        *byte = carry as u8;
        carry >>= 8;
    }
    let mut quotient = [0_u8; 40];
    let mut remainder = 0_u128;
    for (index, byte) in product.into_iter().enumerate() {
        let dividend = (remainder << 8) | u128::from(byte);
        quotient[index] = u8::try_from(dividend / u128::from(divisor))
            .map_err(|_| StratumV1Error::UnsupportedDifficulty)?;
        remainder = dividend % u128::from(divisor);
    }
    if quotient[..8].iter().any(|byte| *byte != 0) {
        return Ok([u8::MAX; 32]);
    }
    quotient[8..]
        .try_into()
        .map_err(|_| StratumV1Error::UnsupportedDifficulty)
}

pub(super) fn submitted_header(
    job: &StratumJob,
    extranonce1: &str,
    extranonce2: &str,
    ntime: &str,
    nonce: &str,
) -> Result<[u8; 80], StratumV1Error> {
    let mut coinbase = decode_hex(&job.coinbase_prefix)?;
    coinbase.extend(decode_hex(extranonce1)?);
    coinbase.extend(decode_hex(extranonce2)?);
    coinbase.extend(decode_hex(&job.coinbase_suffix)?);
    let mut merkle_root = coinbase_txid(&coinbase)?;
    for branch in &job.merkle_branches {
        let branch = decode_fixed_hex::<32>(branch)?;
        let mut joined = merkle_root.to_vec();
        joined.extend_from_slice(&branch);
        merkle_root = double_sha256(&joined);
    }
    let mut header = Vec::with_capacity(80);
    header.extend(reverse_fixed(decode_fixed_hex::<4>(&job.version)?));
    header.extend(stratum_previous_block_bytes(&job.previous_block_hash)?);
    header.extend(merkle_root);
    header.extend(reverse_fixed(decode_fixed_hex::<4>(ntime)?));
    header.extend(reverse_fixed(decode_fixed_hex::<4>(&job.network_bits)?));
    header.extend(reverse_fixed(decode_fixed_hex::<4>(nonce)?));
    header.try_into().map_err(|_| StratumV1Error::InvalidFrame)
}

fn coinbase_txid(coinbase: &[u8]) -> Result<[u8; 32], StratumV1Error> {
    let has_witness = coinbase.get(4) == Some(&0) && coinbase.get(5).is_some_and(|flag| *flag != 0);
    if !has_witness {
        return Ok(double_sha256(coinbase));
    }
    let transaction = bitcoin::consensus::deserialize::<bitcoin::Transaction>(coinbase)
        .map_err(|_| StratumV1Error::InvalidFrame)?;
    Ok(transaction.compute_txid().to_raw_hash().to_byte_array())
}

fn stratum_previous_block_bytes(value: &str) -> Result<[u8; 32], StratumV1Error> {
    let mut bytes = decode_fixed_hex::<32>(value)?;
    for word in bytes.chunks_exact_mut(4) {
        word.reverse();
    }
    Ok(bytes)
}

pub(super) fn classify_network_target(
    header: &[u8; 80],
    network_bits: &str,
) -> Result<NetworkTargetOutcome, StratumV1Error> {
    let mut hash = double_sha256(header);
    hash.reverse();
    let target = compact_target(network_bits)?;
    Ok(if hash <= target {
        NetworkTargetOutcome::NetworkTargetMet
    } else {
        NetworkTargetOutcome::BelowNetworkTarget
    })
}

pub(super) fn meets_assigned_target(header: &[u8; 80], target: &[u8; 32]) -> bool {
    let mut hash = double_sha256(header);
    hash.reverse();
    hash <= *target
}

fn compact_target(network_bits: &str) -> Result<[u8; 32], StratumV1Error> {
    let compact = u32::from_be_bytes(decode_fixed_hex::<4>(network_bits)?);
    let exponent = usize::try_from(compact >> 24).map_err(|_| StratumV1Error::InvalidFrame)?;
    let mantissa = compact & 0x007f_ffff;
    if compact & 0x0080_0000 != 0 || mantissa == 0 || exponent > 32 {
        return Err(StratumV1Error::InvalidFrame);
    }
    let mut target = [0_u8; 32];
    if exponent <= 3 {
        let value = mantissa >> (8 * (3 - exponent));
        let encoded = value.to_be_bytes();
        target[28..].copy_from_slice(&encoded);
        return Ok(target);
    }
    let start = 32 - exponent;
    target[start] = (mantissa >> 16) as u8;
    target[start + 1] = (mantissa >> 8) as u8;
    target[start + 2] = mantissa as u8;
    Ok(target)
}

fn double_sha256(input: &[u8]) -> [u8; 32] {
    let first = digest::digest(&digest::SHA256, input);
    digest::digest(&digest::SHA256, first.as_ref())
        .as_ref()
        .try_into()
        .expect("SHA-256 output is always 32 bytes")
}

fn decode_fixed_hex<const SIZE: usize>(value: &str) -> Result<[u8; SIZE], StratumV1Error> {
    decode_hex(value)?
        .try_into()
        .map_err(|_| StratumV1Error::InvalidFrame)
}

fn decode_hex(value: &str) -> Result<Vec<u8>, StratumV1Error> {
    if value.is_empty() || !value.len().is_multiple_of(2) {
        return Err(StratumV1Error::InvalidFrame);
    }
    (0..value.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&value[index..index + 2], 16)
                .map_err(|_| StratumV1Error::InvalidFrame)
        })
        .collect()
}

fn reverse_fixed<const SIZE: usize>(mut value: [u8; SIZE]) -> [u8; SIZE] {
    value.reverse();
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hydra_word_swapped_previous_hash_becomes_header_little_endian() -> Result<(), StratumV1Error>
    {
        // Arrange
        let hydra_notify_hash = "4f03468e954d4b54b0d36c99ae9b76c3691634587302e480d324926641860e23";

        // Act
        let header_bytes = stratum_previous_block_bytes(hydra_notify_hash)?;

        // Assert
        assert_eq!(
            header_bytes,
            decode_fixed_hex::<32>(
                "8e46034f544b4d95996cd3b0c3769bae5834166980e40273669224d3230e8641"
            )?
        );
        Ok(())
    }

    #[test]
    fn segwit_serialization_uses_the_independently_published_txid_not_wtxid()
    -> Result<(), StratumV1Error> {
        // Arrange: fixed Bitcoin Core GBT transaction vector. Its published txid is
        // 74d7b9bf9f51dd7447e117b6a835a20b6f7d5d807285d1435da37574563ca525.
        let serialized = decode_hex(
            "02000000000101d6c83b002c07d56399a5e0c887ddc7b74071b301a3ffa630c15754c63d8bee750000000000fdffffff02ac78f62901000000160014aecdd0cfae0829ee25e172cc8a94b2aa702869a040420f0000000000160014230a8d012b7cfce1a3118c617d6c50ce9f7482d602473044022037aede936712b0e32aaeba0413833f66929b1bff3726414294b1b140cc93595402204aa43cce61d2c8a9e8131aa335d884212bc2d63f74fea0c13c8ade3640f4b291012103555f1c1815b0a5a5ce7eeac3b7da8923e2c440ed94fc40e9d2685ed45f5335b5bb030000",
        )?;

        // Act
        let txid_bytes = coinbase_txid(&serialized)?;

        // Assert: internal merkle bytes are the byte-reversed display txid.
        assert_eq!(
            txid_bytes,
            decode_fixed_hex::<32>(
                "25a53c567475a35d43d18572805d7d6f0ba235a8b617e14774dd519fbfb9d774"
            )?
        );
        Ok(())
    }
}
