use std::{collections::HashSet, num::NonZeroU64};

use serde::{Deserialize, Serialize, Serializer};
use thiserror::Error;

const MAX_ACTION_REFERENCE_LENGTH: usize = 256;
const MAX_CHALLENGE_ID_LENGTH: usize = 128;
const MAX_CLAIMANT_KEY_LENGTH: usize = 4096;
const LIGHT_EXPECTED_HASHES_VALUE: u64 = 1_u64 << 42;
const STANDARD_EXPECTED_HASHES_VALUE: u64 = 1_u64 << 44;
const LIGHT_EXPECTED_HASHES: NonZeroU64 =
    NonZeroU64::new(LIGHT_EXPECTED_HASHES_VALUE).expect("the Light preset is non-zero");
const STANDARD_EXPECTED_HASHES: NonZeroU64 =
    NonZeroU64::new(STANDARD_EXPECTED_HASHES_VALUE).expect("the Standard preset is non-zero");
const STANDARD_OVERRIDE_MINIMUM: u64 = 1_u64 << 43;
const STANDARD_OVERRIDE_MAXIMUM: u64 = 1_u64 << 45;
const LIGHT_TTL_SECONDS: u64 = 15 * 60;

#[cfg(test)]
mod tests;

/// A policy revision from which authoritative challenge terms are derived.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionPolicy {
    AccountCreationLightV1,
    AccountCreationStandardV1,
}

impl ActionPolicy {
    /// Stable identifier for the immutable Light policy revision.
    pub const ACCOUNT_CREATION_LIGHT_V1: &'static str = "account-creation.light.v1";
    /// Stable identifier for the immutable Standard policy revision.
    pub const ACCOUNT_CREATION_STANDARD_V1: &'static str = "account-creation.standard.v1";
    /// Every Action Policy revision published by this implementation.
    pub const ALL: [Self; 2] = [
        Self::AccountCreationLightV1,
        Self::AccountCreationStandardV1,
    ];

    /// Parses the stable identifier of a supported policy revision.
    pub fn parse(value: &str) -> Result<Self, ChallengeError> {
        match value {
            Self::ACCOUNT_CREATION_LIGHT_V1 => Ok(Self::AccountCreationLightV1),
            Self::ACCOUNT_CREATION_STANDARD_V1 => Ok(Self::AccountCreationStandardV1),
            _ => Err(ChallengeError::UnknownActionPolicy),
        }
    }

    /// Returns the stable revision identifier.
    pub fn id(self) -> &'static str {
        match self {
            Self::AccountCreationLightV1 => Self::ACCOUNT_CREATION_LIGHT_V1,
            Self::AccountCreationStandardV1 => Self::ACCOUNT_CREATION_STANDARD_V1,
        }
    }

    fn work_requirement(
        self,
        maybe_override: Option<&WorkRequirementOverride>,
    ) -> Result<WorkRequirement, ChallengeError> {
        match (self, maybe_override) {
            (Self::AccountCreationLightV1, None) => Ok(WorkRequirement {
                expected_hashes: ExpectedHashes::from(LIGHT_EXPECTED_HASHES),
            }),
            (Self::AccountCreationLightV1, Some(_)) => Err(ChallengeError::OverrideNotPermitted),
            (Self::AccountCreationStandardV1, None) => Ok(WorkRequirement {
                expected_hashes: ExpectedHashes::from(STANDARD_EXPECTED_HASHES),
            }),
            (Self::AccountCreationStandardV1, Some(work_override)) => {
                let expected_hashes = work_override.expected_hashes.as_u64()?;
                if !(STANDARD_OVERRIDE_MINIMUM..=STANDARD_OVERRIDE_MAXIMUM)
                    .contains(&expected_hashes)
                {
                    return Err(ChallengeError::OverrideOutsideBounds);
                }
                Ok(WorkRequirement {
                    expected_hashes: work_override.expected_hashes.clone(),
                })
            }
        }
    }

    fn accepts(self, work_requirement: &WorkRequirement) -> bool {
        match self {
            Self::AccountCreationLightV1 => {
                work_requirement.expected_hashes == ExpectedHashes::from(LIGHT_EXPECTED_HASHES)
            }
            Self::AccountCreationStandardV1 => {
                work_requirement
                    .expected_hashes
                    .as_u64()
                    .is_ok_and(|value| {
                        (STANDARD_OVERRIDE_MINIMUM..=STANDARD_OVERRIDE_MAXIMUM).contains(&value)
                    })
            }
        }
    }

    /// Returns the exact default Work Requirement for this revision.
    pub fn default_expected_hashes(self) -> u64 {
        match self {
            Self::AccountCreationLightV1 => LIGHT_EXPECTED_HASHES_VALUE,
            Self::AccountCreationStandardV1 => STANDARD_EXPECTED_HASHES_VALUE,
        }
    }

    /// Returns the inclusive exact-work override bounds when overrides are permitted.
    pub fn expected_hash_override_bounds(self) -> Option<(u64, u64)> {
        match self {
            Self::AccountCreationLightV1 => None,
            Self::AccountCreationStandardV1 => {
                Some((STANDARD_OVERRIDE_MINIMUM, STANDARD_OVERRIDE_MAXIMUM))
            }
        }
    }

    /// Returns the immutable challenge lifetime for this revision.
    pub fn challenge_ttl_seconds(self) -> u64 {
        match self {
            Self::AccountCreationLightV1 => LIGHT_TTL_SECONDS,
            Self::AccountCreationStandardV1 => LIGHT_TTL_SECONDS,
        }
    }
}

impl Serialize for ActionPolicy {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.id())
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

/// The configured Relying Service audience bound into a Work Challenge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct RelyingServiceAudience(String);

impl TryFrom<String> for RelyingServiceAudience {
    type Error = ChallengeError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if !is_https_url(&value) {
            return Err(ChallengeError::InvalidRelyingServiceAudience);
        }
        Ok(Self(value))
    }
}

/// Browser origins permitted to present one issued Work Challenge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct AllowedOrigins(Vec<String>);

impl TryFrom<Vec<String>> for AllowedOrigins {
    type Error = ChallengeError;

    fn try_from(value: Vec<String>) -> Result<Self, Self::Error> {
        let unique = value.iter().collect::<HashSet<_>>();
        if value.is_empty()
            || unique.len() != value.len()
            || value.iter().any(|origin| !is_https_origin(origin))
        {
            return Err(ChallengeError::InvalidAllowedOrigins);
        }
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

impl ExpectedHashes {
    fn as_u64(&self) -> Result<u64, ChallengeError> {
        self.0
            .parse()
            .map_err(|_| ChallengeError::InvalidExpectedHashes)
    }
}

/// An explicitly permitted exact-work override selected by a backend.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkRequirementOverride {
    expected_hashes: ExpectedHashes,
}

impl WorkRequirementOverride {
    /// Parses an exact canonical expected-hashes override.
    pub fn expected_hashes(value: String) -> Result<Self, ChallengeError> {
        Ok(Self {
            expected_hashes: ExpectedHashes::try_from(value)?,
        })
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
    relying_service_audience: RelyingServiceAudience,
    allowed_origins: AllowedOrigins,
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
    relying_service_audience: String,
    allowed_origins: Vec<String>,
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
        if !action_policy.accepts(&work_requirement) {
            return Err(ChallengeError::PolicyWorkMismatch);
        }

        Ok(Self {
            challenge_id: ChallengeId::try_from(wire.challenge_id)?,
            action_policy,
            action_reference: ActionReference::try_from(wire.action_reference)?,
            claimant_key: ClaimantKey::try_from(wire.claimant_key)?,
            relying_service_audience: RelyingServiceAudience::try_from(
                wire.relying_service_audience,
            )?,
            allowed_origins: AllowedOrigins::try_from(wire.allowed_origins)?,
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
    pub relying_service_audience: RelyingServiceAudience,
    pub allowed_origins: AllowedOrigins,
    pub maybe_work_requirement_override: Option<WorkRequirementOverride>,
}

/// Creates a descriptor using policy-owned terms and adapter-supplied effects.
pub fn issue_challenge(
    command: IssueChallengeCommand,
    challenge_id: String,
    issued_at_unix_seconds: u64,
) -> Result<WorkChallengeDescriptor, ChallengeError> {
    let work_requirement = command
        .action_policy
        .work_requirement(command.maybe_work_requirement_override.as_ref())?;
    let expires_at_unix_seconds = issued_at_unix_seconds
        .checked_add(command.action_policy.challenge_ttl_seconds())
        .ok_or(ChallengeError::ExpiryOverflow)?;

    Ok(WorkChallengeDescriptor {
        challenge_id: ChallengeId::try_from(challenge_id)?,
        action_policy: command.action_policy,
        action_reference: command.action_reference,
        claimant_key: command.claimant_key,
        relying_service_audience: command.relying_service_audience,
        allowed_origins: command.allowed_origins,
        work_requirement,
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
    #[error("Relying Service audience must be an HTTPS URL")]
    InvalidRelyingServiceAudience,
    #[error("allowed origins must be unique HTTPS origins")]
    InvalidAllowedOrigins,
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
    #[error("the selected Action Policy does not permit a work override")]
    OverrideNotPermitted,
    #[error("the work override is outside the Action Policy bounds")]
    OverrideOutsideBounds,
    #[error("unsupported protocol version")]
    UnsupportedProtocolVersion,
}

fn validate_bounded_value(value: &str, maximum_length: usize) -> Result<(), ()> {
    if value.is_empty() || value.len() > maximum_length {
        return Err(());
    }

    Ok(())
}

fn is_https_url(value: &str) -> bool {
    value.starts_with("https://") && value.len() > "https://".len()
}

fn is_https_origin(value: &str) -> bool {
    let Some(authority) = value.strip_prefix("https://") else {
        return false;
    };
    !authority.is_empty()
        && !authority.contains('/')
        && !authority.contains('?')
        && !authority.contains('#')
}
