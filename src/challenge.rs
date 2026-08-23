use std::num::NonZeroU64;

use serde::{Deserialize, Serialize, Serializer};
use thiserror::Error;

const MAX_ACTION_REFERENCE_LENGTH: usize = 256;
const MAX_CHALLENGE_ID_LENGTH: usize = 128;
const MAX_CLAIMANT_KEY_LENGTH: usize = 4096;
const LIGHT_EXPECTED_HASHES: NonZeroU64 =
    NonZeroU64::new(1_u64 << 42).expect("the Light preset is non-zero");
const LIGHT_TTL_SECONDS: u64 = 15 * 60;

#[cfg(test)]
mod tests;

/// A policy revision from which authoritative challenge terms are derived.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionPolicy {
    AccountCreationLightV1,
}

impl ActionPolicy {
    pub const ACCOUNT_CREATION_LIGHT_V1: &'static str = "account-creation.light.v1";

    /// Parses the stable identifier of a supported policy revision.
    pub fn parse(value: &str) -> Result<Self, ChallengeError> {
        match value {
            Self::ACCOUNT_CREATION_LIGHT_V1 => Ok(Self::AccountCreationLightV1),
            _ => Err(ChallengeError::UnknownActionPolicy),
        }
    }

    fn descriptor(self) -> &'static str {
        match self {
            Self::AccountCreationLightV1 => Self::ACCOUNT_CREATION_LIGHT_V1,
        }
    }

    fn work_requirement(self) -> WorkRequirement {
        match self {
            Self::AccountCreationLightV1 => WorkRequirement {
                expected_hashes: ExpectedHashes::from(LIGHT_EXPECTED_HASHES),
            },
        }
    }

    fn ttl_seconds(self) -> u64 {
        match self {
            Self::AccountCreationLightV1 => LIGHT_TTL_SECONDS,
        }
    }
}

impl Serialize for ActionPolicy {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.descriptor())
    }
}

/// An opaque Relying Service reference that reveals no protected-action payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct ActionReference(String);

impl TryFrom<String> for ActionReference {
    type Error = ChallengeError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        validate_bounded_value(&value, MAX_ACTION_REFERENCE_LENGTH)
            .map_err(|()| ChallengeError::InvalidActionReference)?;
        Ok(Self(value))
    }
}

/// The opaque serialization of the Claimant's challenge-scoped public key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct ClaimantKey(String);

impl TryFrom<String> for ClaimantKey {
    type Error = ChallengeError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        validate_bounded_value(&value, MAX_CLAIMANT_KEY_LENGTH)
            .map_err(|()| ChallengeError::InvalidClaimantKey)?;
        Ok(Self(value))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
struct ChallengeId(String);

impl TryFrom<String> for ChallengeId {
    type Error = ChallengeError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        let maybe_suffix = value.strip_prefix("challenge_");
        let Some(suffix) = maybe_suffix else {
            return Err(ChallengeError::InvalidChallengeId);
        };
        if suffix.is_empty()
            || !suffix.bytes().all(|byte| byte.is_ascii_alphanumeric())
            || value.len() > MAX_CHALLENGE_ID_LENGTH
        {
            return Err(ChallengeError::InvalidChallengeId);
        }

        Ok(Self(value))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
struct ExpectedHashes(String);

impl From<NonZeroU64> for ExpectedHashes {
    fn from(value: NonZeroU64) -> Self {
        Self(value.to_string())
    }
}

impl TryFrom<String> for ExpectedHashes {
    type Error = ChallengeError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        let is_canonical = !value.is_empty()
            && !value.starts_with('0')
            && value.bytes().all(|byte| byte.is_ascii_digit());
        if !is_canonical {
            return Err(ChallengeError::InvalidExpectedHashes);
        }

        Ok(Self(value))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(transparent)]
struct ExpiresAtUnixSeconds(u64);

impl TryFrom<u64> for ExpiresAtUnixSeconds {
    type Error = ChallengeError;

    fn try_from(value: u64) -> Result<Self, Self::Error> {
        if value == 0 {
            return Err(ChallengeError::InvalidExpiry);
        }

        Ok(Self(value))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProtocolVersion {
    Development0_1,
}

impl ProtocolVersion {
    const DEVELOPMENT_0_1: &'static str = "BWG/0.1";

    fn parse(value: &str) -> Result<Self, ChallengeError> {
        match value {
            Self::DEVELOPMENT_0_1 => Ok(Self::Development0_1),
            _ => Err(ChallengeError::UnsupportedProtocolVersion),
        }
    }

    fn descriptor(self) -> &'static str {
        match self {
            Self::Development0_1 => Self::DEVELOPMENT_0_1,
        }
    }
}

impl Serialize for ProtocolVersion {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.descriptor())
    }
}

/// Exact authoritative work required to satisfy a challenge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkRequirement {
    expected_hashes: ExpectedHashes,
}

/// The immutable browser-safe description of an issued Work Challenge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "WorkChallengeDescriptorWire")]
pub struct WorkChallengeDescriptor {
    challenge_id: ChallengeId,
    action_policy: ActionPolicy,
    action_reference: ActionReference,
    claimant_key: ClaimantKey,
    work_requirement: WorkRequirement,
    expires_at_unix_seconds: ExpiresAtUnixSeconds,
    protocol_version: ProtocolVersion,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkChallengeDescriptorWire {
    challenge_id: String,
    action_policy: String,
    action_reference: String,
    claimant_key: String,
    work_requirement: WorkRequirementWire,
    expires_at_unix_seconds: u64,
    protocol_version: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkRequirementWire {
    expected_hashes: String,
}

impl TryFrom<WorkChallengeDescriptorWire> for WorkChallengeDescriptor {
    type Error = ChallengeError;

    fn try_from(wire: WorkChallengeDescriptorWire) -> Result<Self, Self::Error> {
        let action_policy = ActionPolicy::parse(&wire.action_policy)?;
        let work_requirement = WorkRequirement {
            expected_hashes: ExpectedHashes::try_from(wire.work_requirement.expected_hashes)?,
        };
        if work_requirement != action_policy.work_requirement() {
            return Err(ChallengeError::PolicyWorkMismatch);
        }

        Ok(Self {
            challenge_id: ChallengeId::try_from(wire.challenge_id)?,
            action_policy,
            action_reference: ActionReference::try_from(wire.action_reference)?,
            claimant_key: ClaimantKey::try_from(wire.claimant_key)?,
            work_requirement,
            expires_at_unix_seconds: ExpiresAtUnixSeconds::try_from(wire.expires_at_unix_seconds)?,
            protocol_version: ProtocolVersion::parse(&wire.protocol_version)?,
        })
    }
}

/// Parsed data supplied by an authenticated Relying Service backend.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueChallengeCommand {
    pub action_policy: ActionPolicy,
    pub action_reference: ActionReference,
    pub claimant_key: ClaimantKey,
}

/// Creates a descriptor using policy-owned terms and adapter-supplied effects.
pub fn issue_challenge(
    command: IssueChallengeCommand,
    challenge_id: String,
    issued_at_unix_seconds: u64,
) -> Result<WorkChallengeDescriptor, ChallengeError> {
    let expires_at_unix_seconds = issued_at_unix_seconds
        .checked_add(command.action_policy.ttl_seconds())
        .ok_or(ChallengeError::ExpiryOverflow)?;

    Ok(WorkChallengeDescriptor {
        challenge_id: ChallengeId::try_from(challenge_id)?,
        action_policy: command.action_policy,
        action_reference: command.action_reference,
        claimant_key: command.claimant_key,
        work_requirement: command.action_policy.work_requirement(),
        expires_at_unix_seconds: ExpiresAtUnixSeconds::try_from(expires_at_unix_seconds)?,
        protocol_version: ProtocolVersion::Development0_1,
    })
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ChallengeError {
    #[error("unknown Action Policy")]
    UnknownActionPolicy,
    #[error("Action Reference must be non-empty and at most 256 bytes")]
    InvalidActionReference,
    #[error("Claimant key must be non-empty and at most 4096 bytes")]
    InvalidClaimantKey,
    #[error("challenge identifier is invalid")]
    InvalidChallengeId,
    #[error("expected hashes must be a non-zero canonical decimal integer")]
    InvalidExpectedHashes,
    #[error("challenge expiry must be after the Unix epoch")]
    InvalidExpiry,
    #[error("challenge expiry is outside the supported time range")]
    ExpiryOverflow,
    #[error("challenge work does not match its Action Policy")]
    PolicyWorkMismatch,
    #[error("unsupported protocol version")]
    UnsupportedProtocolVersion,
}

fn validate_bounded_value(value: &str, maximum_length: usize) -> Result<(), ()> {
    if value.is_empty() || value.len() > maximum_length {
        return Err(());
    }

    Ok(())
}
