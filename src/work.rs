use std::num::NonZeroU64;

use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};
use thiserror::Error;

#[cfg(test)]
mod tests;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Uint256([u64; 4]);

impl Uint256 {
    const MAX: Self = Self([u64::MAX; 4]);
    const ONE: Self = Self([1, 0, 0, 0]);
    const ZERO: Self = Self([0; 4]);

    fn from_be_bytes(bytes: [u8; 32]) -> Self {
        let mut limbs = [0_u64; 4];
        for (index, chunk) in bytes.chunks_exact(8).enumerate() {
            let mut limb_bytes = [0_u8; 8];
            limb_bytes.copy_from_slice(chunk);
            limbs[3 - index] = u64::from_be_bytes(limb_bytes);
        }

        Self(limbs)
    }

    fn from_u64(value: u64) -> Self {
        Self([value, 0, 0, 0])
    }

    fn maybe_to_u64(self) -> Option<u64> {
        (self.0[1..] == [0; 3]).then_some(self.0[0])
    }

    fn to_be_bytes(self) -> [u8; 32] {
        let mut bytes = [0_u8; 32];
        for (index, limb) in self.0.into_iter().rev().enumerate() {
            bytes[index * 8..(index + 1) * 8].copy_from_slice(&limb.to_be_bytes());
        }

        bytes
    }

    fn maybe_checked_add(self, other: Self) -> Option<Self> {
        let mut sum = [0_u64; 4];
        let mut carry = false;
        for (index, limb) in sum.iter_mut().enumerate() {
            let (partial, first_carry) = self.0[index].overflowing_add(other.0[index]);
            let (total, second_carry) = partial.overflowing_add(u64::from(carry));
            *limb = total;
            carry = first_carry || second_carry;
        }

        (!carry).then_some(Self(sum))
    }

    fn maybe_checked_mul_small_add(self, multiplier: u64, addend: u64) -> Option<Self> {
        let mut product = [0_u64; 4];
        let mut carry = u128::from(addend);
        for (index, limb) in product.iter_mut().enumerate() {
            let value = u128::from(self.0[index]) * u128::from(multiplier) + carry;
            *limb = value as u64;
            carry = value >> 64;
        }

        (carry == 0).then_some(Self(product))
    }

    fn bitwise_not(self) -> Self {
        Self(self.0.map(|limb| !limb))
    }

    fn bit(self, index: usize) -> bool {
        self.0[index / 64] & (1_u64 << (index % 64)) != 0
    }

    fn set_bit(&mut self, index: usize) {
        self.0[index / 64] |= 1_u64 << (index % 64);
    }

    fn shift_left_one(self) -> Self {
        let mut shifted = [0_u64; 4];
        let mut carry = 0_u64;
        for (index, limb) in self.0.into_iter().enumerate() {
            shifted[index] = (limb << 1) | carry;
            carry = limb >> 63;
        }

        Self(shifted)
    }

    fn subtract(self, other: Self) -> Self {
        let mut difference = [0_u64; 4];
        let mut borrow = false;
        for (index, limb) in difference.iter_mut().enumerate() {
            let (partial, first_borrow) = self.0[index].overflowing_sub(other.0[index]);
            let (total, second_borrow) = partial.overflowing_sub(u64::from(borrow));
            *limb = total;
            borrow = first_borrow || second_borrow;
        }
        debug_assert!(!borrow, "subtraction requires a greater dividend");

        Self(difference)
    }

    fn divide(self, divisor: Self) -> Self {
        debug_assert!(
            divisor != Self::ZERO,
            "division requires a non-zero divisor"
        );
        let mut quotient = Self::ZERO;
        let mut remainder = Self::ZERO;

        for bit_index in (0..256).rev() {
            remainder = remainder.shift_left_one();
            if self.bit(bit_index) {
                remainder.0[0] |= 1;
            }
            if remainder < divisor {
                continue;
            }

            remainder = remainder.subtract(divisor);
            quotient.set_bit(bit_index);
        }

        quotient
    }

    fn divide_small(self, divisor: u64) -> (Self, u64) {
        let mut quotient = [0_u64; 4];
        let mut remainder = 0_u128;
        for index in (0..4).rev() {
            let dividend = (remainder << 64) | u128::from(self.0[index]);
            quotient[index] = (dividend / u128::from(divisor)) as u64;
            remainder = dividend % u128::from(divisor);
        }

        (Self(quotient), remainder as u64)
    }

    fn to_decimal_string(self) -> String {
        if self == Self::ZERO {
            return "0".to_owned();
        }

        let mut remaining = self;
        let mut digits = Vec::new();
        while remaining != Self::ZERO {
            let (quotient, digit) = remaining.divide_small(10);
            digits.push(char::from(b'0' + digit as u8));
            remaining = quotient;
        }
        digits.into_iter().rev().collect()
    }

    fn as_f64(self) -> f64 {
        self.0.into_iter().rev().fold(0_f64, |value, limb| {
            value.mul_add(2_f64.powi(64), limb as f64)
        })
    }
}

impl PartialOrd for Uint256 {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Uint256 {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        for index in (0..4).rev() {
            match self.0[index].cmp(&other.0[index]) {
                std::cmp::Ordering::Equal => {}
                ordering => return ordering,
            }
        }

        std::cmp::Ordering::Equal
    }
}

/// The 256-bit target assigned by a Mining Pool for an accepted result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AssignedTarget([u8; 32]);

impl AssignedTarget {
    /// Parses a fixed-width, most-significant-byte-first target.
    pub fn from_be_bytes(bytes: [u8; 32]) -> Result<Self, WorkError> {
        if bytes == [0; 32] {
            return Err(WorkError::ZeroTarget);
        }

        Ok(Self(bytes))
    }

    /// Calculates integer expected hashes for this target.
    pub fn credited_work(self) -> CreditedWork {
        let target = Uint256::from_be_bytes(self.0);
        if target == Uint256::MAX {
            return CreditedWork(Uint256::ONE);
        }

        let Some(divisor) = target.maybe_checked_add(Uint256::ONE) else {
            unreachable!("the maximum target was handled above");
        };
        let quotient = target.bitwise_not().divide(divisor);
        let Some(work) = quotient.maybe_checked_add(Uint256::ONE) else {
            unreachable!("a non-zero target produces work within 256 bits");
        };

        CreditedWork(work)
    }
}

impl TryFrom<&[u8]> for AssignedTarget {
    type Error = WorkError;

    fn try_from(value: &[u8]) -> Result<Self, Self::Error> {
        let Ok(bytes) = <[u8; 32]>::try_from(value) else {
            return Err(WorkError::InvalidTargetLength);
        };

        Self::from_be_bytes(bytes)
    }
}

/// Exact integer expected hashes credited for an accepted result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CreditedWork(Uint256);

impl CreditedWork {
    /// Creates exact non-zero work from a bounded integer without reparsing.
    pub fn from_non_zero_u64(value: NonZeroU64) -> Self {
        Self(Uint256::from_u64(value.get()))
    }

    /// Converts exact work to `u64` when it fits that bounded representation.
    pub fn try_to_u64(self) -> Result<u64, WorkError> {
        self.0
            .maybe_to_u64()
            .ok_or(WorkError::CreditedWorkOutsideU64)
    }
    /// Parses the fixed-width, most-significant-byte-first binary contract.
    pub fn from_be_bytes(bytes: [u8; 32]) -> Result<Self, WorkError> {
        let value = Uint256::from_be_bytes(bytes);
        if value == Uint256::ZERO {
            return Err(WorkError::ZeroCreditedWork);
        }

        Ok(Self(value))
    }

    /// Returns the fixed-width, most-significant-byte-first binary contract.
    pub fn to_be_bytes(self) -> [u8; 32] {
        self.0.to_be_bytes()
    }

    /// Returns the canonical base-10 representation used by JSON contracts.
    pub fn to_decimal_string(self) -> String {
        self.0.to_decimal_string()
    }

    /// Derives the non-authoritative base-2 display equivalent of this exact work.
    pub fn equivalent_binary_zero_work(self) -> f64 {
        self.0.as_f64().log2()
    }

    /// Adds exact work while rejecting values outside the fixed-width contract.
    pub fn checked_add(self, other: Self) -> Result<Self, WorkError> {
        self.0
            .maybe_checked_add(other.0)
            .map(Self)
            .ok_or(WorkError::CreditedWorkOverflow)
    }
}

/// Exact cumulative Credited Work, including the valid zero-progress state.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct VerifiedProgress(Uint256);

impl VerifiedProgress {
    /// Returns zero Verified Progress for a newly issued challenge.
    pub fn zero() -> Self {
        Self(Uint256::ZERO)
    }

    /// Adds one accepted-work credit while rejecting fixed-width overflow.
    pub fn checked_add(self, credited_work: CreditedWork) -> Result<Self, WorkError> {
        self.0
            .maybe_checked_add(credited_work.0)
            .map(Self)
            .ok_or(WorkError::CreditedWorkOverflow)
    }

    /// Returns the canonical exact decimal representation.
    pub fn to_decimal_string(self) -> String {
        self.0.to_decimal_string()
    }

    /// Returns whether cumulative progress meets an exact Work Requirement.
    pub fn meets(self, work_requirement: CreditedWork) -> bool {
        self.0 >= work_requirement.0
    }
}

impl Serialize for VerifiedProgress {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0.to_decimal_string())
    }
}

impl TryFrom<String> for CreditedWork {
    type Error = WorkError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        let is_canonical = !value.is_empty()
            && !value.starts_with('0')
            && value.bytes().all(|byte| byte.is_ascii_digit());
        if !is_canonical {
            return Err(WorkError::InvalidCreditedWorkDecimal);
        }

        let mut parsed = Uint256::ZERO;
        for byte in value.bytes() {
            let digit = u64::from(byte - b'0');
            let Some(next) = parsed.maybe_checked_mul_small_add(10, digit) else {
                return Err(WorkError::CreditedWorkOverflow);
            };
            parsed = next;
        }

        Ok(Self(parsed))
    }
}

impl Serialize for CreditedWork {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0.to_decimal_string())
    }
}

impl<'de> Deserialize<'de> for CreditedWork {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::try_from(value).map_err(D::Error::custom)
    }
}

/// Explicit failures while parsing or accumulating exact work values.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum WorkError {
    #[error("assigned target must use exactly 32 bytes")]
    InvalidTargetLength,
    #[error("assigned target must be non-zero")]
    ZeroTarget,
    #[error("Credited Work must be non-zero")]
    ZeroCreditedWork,
    #[error("Credited Work JSON must be a non-zero canonical decimal string")]
    InvalidCreditedWorkDecimal,
    #[error("Credited Work exceeds the fixed-width unsigned range")]
    CreditedWorkOverflow,
    #[error("Credited Work does not fit the bounded u64 representation")]
    CreditedWorkOutsideU64,
}
