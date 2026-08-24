use ring::digest;

use super::{PoolOfferError, validate_id};

/// Raw per-challenge choice accepted only by the Pool Adapter boundary.
#[derive(Clone, PartialEq, Eq)]
pub struct PoolSelection {
    pub(super) offer_id: String,
    pub(super) payout: PayoutChoice,
}

impl PoolSelection {
    /// Selects a fresh Bitcoin mainnet receive address for direct coinbase payout.
    pub fn bitcoin_address(offer_id: String, address: String) -> Result<Self, PoolOfferError> {
        validate_id(&offer_id)?;
        if !valid_mainnet_address(&address) {
            return Err(PoolOfferError::InvalidPayoutSelection);
        }
        Ok(Self {
            offer_id,
            payout: PayoutChoice::BitcoinAddress { address },
        })
    }

    /// Selects one beneficiary explicitly approved and disclosed by the offer.
    pub fn approved_beneficiary(
        offer_id: String,
        beneficiary_id: String,
    ) -> Result<Self, PoolOfferError> {
        validate_id(&offer_id)?;
        validate_id(&beneficiary_id)?;
        Ok(Self {
            offer_id,
            payout: PayoutChoice::ApprovedBeneficiary { beneficiary_id },
        })
    }

    pub(crate) fn offer_id(&self) -> &str {
        &self.offer_id
    }

    /// Local-only destination or beneficiary identifier shown before Work Consent.
    pub fn payout_destination(&self) -> &str {
        match &self.payout {
            PayoutChoice::BitcoinAddress { address } => address,
            PayoutChoice::ApprovedBeneficiary { beneficiary_id } => beneficiary_id,
        }
    }

    /// Stable disclosed destination classification.
    pub fn payout_destination_type(&self) -> &str {
        match &self.payout {
            PayoutChoice::BitcoinAddress { .. } => "bitcoin_mainnet_address",
            PayoutChoice::ApprovedBeneficiary { .. } => "approved_beneficiary",
        }
    }

    pub(crate) fn commitment(&self, challenge_id: &str) -> String {
        let mut input = b"BWG/0.1 pool selection commitment\0".to_vec();
        input.extend_from_slice(challenge_id.as_bytes());
        input.push(0);
        input.extend_from_slice(self.offer_id.as_bytes());
        input.push(0);
        input.extend_from_slice(self.payout_destination_type().as_bytes());
        input.push(0);
        input.extend_from_slice(self.payout_destination().as_bytes());
        digest::digest(&digest::SHA256, &input)
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(super) enum PayoutChoice {
    BitcoinAddress { address: String },
    ApprovedBeneficiary { beneficiary_id: String },
}

/// Opaque durable selection reference; it contains no payout destination bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolSelectionCommitment {
    pool_offer_id: PoolOfferId,
    commitment: PayoutCommitmentDigest,
}

impl PoolSelectionCommitment {
    pub(crate) fn persisted(
        pool_offer_id: String,
        commitment: String,
    ) -> Result<Self, PoolOfferError> {
        Ok(Self {
            pool_offer_id: PoolOfferId::try_from(pool_offer_id)?,
            commitment: PayoutCommitmentDigest::try_from(commitment)?,
        })
    }

    /// Stable approved Pool Offer identity.
    pub fn pool_offer_id(&self) -> &str {
        &self.pool_offer_id.0
    }

    /// SHA-256 commitment used to lock the exact payout choice without retaining it.
    pub fn commitment(&self) -> &str {
        &self.commitment.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PoolOfferId(String);

impl TryFrom<String> for PoolOfferId {
    type Error = PoolOfferError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        validate_id(&value)?;
        Ok(Self(value))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PayoutCommitmentDigest(String);

impl TryFrom<String> for PayoutCommitmentDigest {
    type Error = PoolOfferError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.len() != 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        {
            return Err(PoolOfferError::InvalidPayoutSelection);
        }
        Ok(Self(value))
    }
}

fn valid_mainnet_address(value: &str) -> bool {
    if value.starts_with('1') || value.starts_with('3') {
        return valid_base58check_mainnet(value);
    }
    valid_segwit_mainnet(value)
}

fn valid_base58check_mainnet(value: &str) -> bool {
    const ALPHABET: &str = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut little_endian = Vec::<u8>::new();
    for character in value.chars() {
        let Some(digit) = ALPHABET.find(character) else {
            return false;
        };
        let mut carry = digit as u32;
        for byte in &mut little_endian {
            let total = u32::from(*byte) * 58 + carry;
            *byte = total as u8;
            carry = total >> 8;
        }
        while carry > 0 {
            little_endian.push(carry as u8);
            carry >>= 8;
        }
    }
    let leading_zeroes = value.bytes().take_while(|byte| *byte == b'1').count();
    let mut decoded = vec![0_u8; leading_zeroes];
    decoded.extend(little_endian.into_iter().rev());
    if decoded.len() != 25 || !matches!(decoded[0], 0x00 | 0x05) {
        return false;
    }
    let first = digest::digest(&digest::SHA256, &decoded[..21]);
    let second = digest::digest(&digest::SHA256, first.as_ref());
    decoded[21..] == second.as_ref()[..4]
}

fn valid_segwit_mainnet(value: &str) -> bool {
    const CHARSET: &str = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    let lowercase = value.to_ascii_lowercase();
    if value.len() > 90
        || (value != lowercase && value != value.to_ascii_uppercase())
        || !lowercase.starts_with("bc1")
    {
        return false;
    }
    let Some(separator) = lowercase.rfind('1') else {
        return false;
    };
    let payload = &lowercase[separator + 1..];
    if payload.len() < 7 {
        return false;
    }
    let maybe_values = payload
        .chars()
        .map(|character| CHARSET.find(character).map(|value| value as u8))
        .collect::<Option<Vec<_>>>();
    let Some(values) = maybe_values else {
        return false;
    };
    let checksum = bech32_polymod("bc", &values);
    let witness_version = values[0];
    if witness_version > 16
        || (witness_version == 0 && checksum != 1)
        || (witness_version > 0 && checksum != 0x2bc8_30a3)
    {
        return false;
    }
    let Some(program) = convert_five_to_eight_bits(&values[1..values.len() - 6]) else {
        return false;
    };
    (2..=40).contains(&program.len()) && (witness_version != 0 || matches!(program.len(), 20 | 32))
}

fn bech32_polymod(hrp: &str, values: &[u8]) -> u32 {
    const GENERATORS: [u32; 5] = [
        0x3b6a_57b2,
        0x2650_8e6d,
        0x1ea1_19fa,
        0x3d42_33dd,
        0x2a14_62b3,
    ];
    let expanded = hrp
        .bytes()
        .map(|byte| byte >> 5)
        .chain(std::iter::once(0))
        .chain(hrp.bytes().map(|byte| byte & 31))
        .chain(values.iter().copied());
    expanded.fold(1_u32, |checksum, value| {
        let top = checksum >> 25;
        let mut next = ((checksum & 0x01ff_ffff) << 5) ^ u32::from(value);
        for (index, generator) in GENERATORS.into_iter().enumerate() {
            if (top >> index) & 1 == 1 {
                next ^= generator;
            }
        }
        next
    })
}

fn convert_five_to_eight_bits(values: &[u8]) -> Option<Vec<u8>> {
    let mut accumulator = 0_u32;
    let mut bits = 0_u8;
    let mut output = Vec::new();
    for value in values {
        accumulator = (accumulator << 5) | u32::from(*value);
        bits += 5;
        while bits >= 8 {
            bits -= 8;
            output.push((accumulator >> bits) as u8);
        }
    }
    if bits >= 5 || ((accumulator << (8 - bits)) & 0xff) != 0 {
        return None;
    }
    Some(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bitcoin_mainnet_address_vectors_are_checksum_validated() {
        // Arrange
        let valid = [
            "1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
            "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy",
            "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4",
            "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",
        ];
        let invalid = [
            "1BoatSLRHtKNngkdXEeobR76b53LETtpyU",
            "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn",
            "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd",
            "tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c",
            "bc1pw5dgrnzv",
            "BC130XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ7ZWS8R",
            "tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq47Zagq",
            "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v07qwwzcrf",
            "tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vpggkg4j",
        ];

        // Act
        let valid_results = valid.map(|address| {
            PoolSelection::bitcoin_address("pool_offer_vector".to_owned(), address.to_owned())
        });
        let invalid_results = invalid.map(|address| {
            PoolSelection::bitcoin_address("pool_offer_vector".to_owned(), address.to_owned())
        });

        // Assert
        assert!(valid_results.into_iter().all(|result| result.is_ok()));
        assert!(invalid_results.into_iter().all(|result| result.is_err()));
    }

    #[test]
    fn pool_selection_commitment_matches_the_portable_vector() -> Result<(), PoolOfferError> {
        // Arrange
        let selection = PoolSelection::bitcoin_address(
            "pool_offer_hydra_solo_v1".to_owned(),
            "1BoatSLRHtKNngkdXEeobR76b53LETtpyT".to_owned(),
        )?;
        let beneficiary = PoolSelection::approved_beneficiary(
            "pool_offer_hydra_solo_v1".to_owned(),
            "beneficiary_vector".to_owned(),
        )?;

        // Act
        let commitment = selection.commitment("challenge_vector_01");
        let beneficiary_commitment = beneficiary.commitment("challenge_vector_01");

        // Assert
        assert_eq!(
            commitment,
            "c3bcd7ac4a90962ff8df266680b8402bb16460ab3d4428893c66ea82655e122b"
        );
        assert_eq!(
            beneficiary_commitment,
            "7ccf0698f93f03d8385be2ce67d741cb68b86d71d656a8e2cd278b0faa08bee1"
        );
        Ok(())
    }

    #[test]
    fn persisted_commitment_rejects_primitive_shape_drift() {
        // Arrange / Act
        let invalid_offer =
            PoolSelectionCommitment::persisted("pool offer with spaces".to_owned(), "0".repeat(64));
        let invalid_digest = PoolSelectionCommitment::persisted(
            "pool_offer_valid".to_owned(),
            "not-a-sha256".to_owned(),
        );

        // Assert
        assert!(invalid_offer.is_err());
        assert!(invalid_digest.is_err());
    }
}
