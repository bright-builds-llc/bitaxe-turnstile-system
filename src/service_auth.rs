use std::collections::HashSet;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::rand::{SecureRandom as _, SystemRandom};
use thiserror::Error;

#[cfg(test)]
mod tests;

const MINIMUM_SERVICE_SECRET_LENGTH: usize = 43;
const MAXIMUM_SERVICE_SECRET_LENGTH: usize = 128;
const MINIMUM_DISTINCT_SECRET_CHARACTERS: usize = 16;

/// A validated public identifier for one Relying Service backend.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ServiceClientId(String);

impl ServiceClientId {
    /// Returns the validated client identifier.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for ServiceClientId {
    type Error = ServiceAuthError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.is_empty()
            || value.len() > 128
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            return Err(ServiceAuthError::InvalidClientId);
        }
        Ok(Self(value))
    }
}

/// A validated high-entropy backend secret kept out of debug and serialization surfaces.
#[derive(Clone)]
pub struct ServiceSecret(String);

impl ServiceSecret {
    /// Generates a new 256-bit base64url secret from the operating system CSPRNG.
    pub fn generate() -> Result<Self, ServiceAuthError> {
        let mut bytes = [0_u8; 32];
        SystemRandom::new()
            .fill(&mut bytes)
            .map_err(|_| ServiceAuthError::RandomGenerationFailed)?;
        Self::try_from(URL_SAFE_NO_PAD.encode(bytes))
    }

    /// Returns the validated secret for backend transmission or verifier construction.
    pub fn expose_secret(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for ServiceSecret {
    type Error = ServiceAuthError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        let distinct = value.bytes().collect::<HashSet<_>>();
        if !(MINIMUM_SERVICE_SECRET_LENGTH..=MAXIMUM_SERVICE_SECRET_LENGTH).contains(&value.len())
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            || distinct.len() < MINIMUM_DISTINCT_SECRET_CHARACTERS
        {
            return Err(ServiceAuthError::InvalidServiceSecret);
        }
        Ok(Self(value))
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ServiceAuthError {
    #[error("service client identifier is invalid")]
    InvalidClientId,
    #[error("service secret must be a diverse 43-128 character base64url token")]
    InvalidServiceSecret,
    #[error("operating system random generation failed")]
    RandomGenerationFailed,
}
