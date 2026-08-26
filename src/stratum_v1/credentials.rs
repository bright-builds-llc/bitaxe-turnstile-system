use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::hmac;

use super::StratumV1Error;
use crate::progress::WorkSessionId;

const MAXIMUM_SESSION_CREDENTIAL_SECONDS: u64 = 60;

/// Deterministic issuer for opaque response-loss-safe Stratum Session credentials.
pub struct StratumCredentialIssuer {
    key: hmac::Key,
}

impl StratumCredentialIssuer {
    pub fn new(key: [u8; 32]) -> Self {
        Self {
            key: hmac::Key::new(hmac::HMAC_SHA256, &key),
        }
    }

    pub fn issue(
        &self,
        session_id: WorkSessionId,
        lease_context: StratumLeaseContext,
        now_unix_seconds: u64,
        lease_expires_at_unix_seconds: u64,
        challenge_expires_at_unix_seconds: u64,
    ) -> Result<StratumSessionCredentials, StratumV1Error> {
        let expires_at_unix_seconds = bounded_session_expiry(
            &lease_context,
            now_unix_seconds,
            lease_expires_at_unix_seconds,
            challenge_expires_at_unix_seconds,
        )?;
        let mut username_input = b"BWG/0.1 Stratum username\0".to_vec();
        username_input.extend_from_slice(session_id.as_str().as_bytes());
        let username_tag = hmac::sign(&self.key, &username_input);
        let username = format!(
            "bwg_{}",
            URL_SAFE_NO_PAD.encode(&username_tag.as_ref()[..16])
        );
        let mut secret_input = b"BWG/0.1 Stratum secret\0".to_vec();
        secret_input.extend_from_slice(session_id.as_str().as_bytes());
        secret_input.push(0);
        secret_input.extend_from_slice(&now_unix_seconds.to_be_bytes());
        secret_input.push(0);
        secret_input.extend_from_slice(&expires_at_unix_seconds.to_be_bytes());
        secret_input.push(0);
        secret_input.extend_from_slice(lease_context.lease_id().as_bytes());
        secret_input.push(0);
        secret_input.extend_from_slice(&lease_context.last_monotonic_milliseconds().to_be_bytes());
        let secret = URL_SAFE_NO_PAD.encode(hmac::sign(&self.key, &secret_input).as_ref());
        Ok(StratumSessionCredentials {
            session_id,
            lease_context,
            username,
            secret,
            issued_at_unix_seconds: now_unix_seconds,
            expires_at_unix_seconds,
        })
    }
}

/// Worker-visible short-lived credentials bound to one opaque Work Session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StratumSessionCredentials {
    session_id: WorkSessionId,
    lease_context: StratumLeaseContext,
    username: String,
    secret: String,
    issued_at_unix_seconds: u64,
    expires_at_unix_seconds: u64,
}

impl StratumSessionCredentials {
    pub fn session_id(&self) -> &WorkSessionId {
        &self.session_id
    }

    pub fn username(&self) -> &str {
        &self.username
    }

    pub fn lease_context(&self) -> &StratumLeaseContext {
        &self.lease_context
    }

    pub fn secret(&self) -> &str {
        &self.secret
    }

    pub fn expires_at_unix_seconds(&self) -> u64 {
        self.expires_at_unix_seconds
    }

    pub fn issued_at_unix_seconds(&self) -> u64 {
        self.issued_at_unix_seconds
    }

    pub fn into_session_config(self) -> StratumSessionConfig {
        StratumSessionConfig {
            session_id: self.session_id,
            lease_context: self.lease_context,
            username: self.username,
            secret: self.secret,
            issued_at_unix_seconds: self.issued_at_unix_seconds,
            expires_at_unix_seconds: self.expires_at_unix_seconds,
        }
    }
}

/// Immutable short-lived authorization for one standard Stratum V1 connection.
pub struct StratumSessionConfig {
    pub(super) session_id: WorkSessionId,
    pub(super) lease_context: StratumLeaseContext,
    pub(super) username: String,
    pub(super) secret: String,
    pub(super) issued_at_unix_seconds: u64,
    pub(super) expires_at_unix_seconds: u64,
}

impl StratumSessionConfig {
    pub fn new(
        session_id: WorkSessionId,
        lease_context: StratumLeaseContext,
        username: String,
        secret: String,
        now_unix_seconds: u64,
        lease_expires_at_unix_seconds: u64,
        challenge_expires_at_unix_seconds: u64,
    ) -> Result<Self, StratumV1Error> {
        if username.is_empty() || secret.is_empty() {
            return Err(StratumV1Error::InvalidSessionConfig);
        }
        Ok(Self {
            session_id,
            username,
            secret,
            issued_at_unix_seconds: now_unix_seconds,
            expires_at_unix_seconds: bounded_session_expiry(
                &lease_context,
                now_unix_seconds,
                lease_expires_at_unix_seconds,
                challenge_expires_at_unix_seconds,
            )?,
            lease_context,
        })
    }
}

/// Exact Authority-issued lease and Worker continuity values carried with accepted work.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StratumLeaseContext {
    lease_id: String,
    continuity_id: String,
    last_monotonic_milliseconds: u64,
    renew_at_monotonic_milliseconds: u64,
    expires_at_monotonic_milliseconds: u64,
}

impl StratumLeaseContext {
    pub fn new(
        lease_id: String,
        continuity_id: String,
        last_monotonic_milliseconds: u64,
        renew_at_monotonic_milliseconds: u64,
        expires_at_monotonic_milliseconds: u64,
    ) -> Result<Self, StratumV1Error> {
        if uuid::Uuid::parse_str(&lease_id).is_err()
            || continuity_id.is_empty()
            || continuity_id.len() > 128
            || renew_at_monotonic_milliseconds == 0
            || expires_at_monotonic_milliseconds <= last_monotonic_milliseconds
            || expires_at_monotonic_milliseconds < renew_at_monotonic_milliseconds
        {
            return Err(StratumV1Error::InvalidSessionConfig);
        }
        Ok(Self {
            lease_id,
            continuity_id,
            last_monotonic_milliseconds,
            renew_at_monotonic_milliseconds,
            expires_at_monotonic_milliseconds,
        })
    }

    pub fn lease_id(&self) -> &str {
        &self.lease_id
    }

    pub fn continuity_id(&self) -> &str {
        &self.continuity_id
    }

    pub fn last_monotonic_milliseconds(&self) -> u64 {
        self.last_monotonic_milliseconds
    }

    pub fn renew_at_monotonic_milliseconds(&self) -> u64 {
        self.renew_at_monotonic_milliseconds
    }

    pub fn expires_at_monotonic_milliseconds(&self) -> u64 {
        self.expires_at_monotonic_milliseconds
    }

    pub(super) fn advanced_by_wall_clock(
        &self,
        issued_at_unix_seconds: u64,
        now_unix_seconds: u64,
    ) -> Result<Self, StratumV1Error> {
        let elapsed_seconds = now_unix_seconds
            .checked_sub(issued_at_unix_seconds)
            .ok_or(StratumV1Error::ClockRollback)?;
        let elapsed_milliseconds = elapsed_seconds
            .checked_mul(1_000)
            .ok_or(StratumV1Error::InvalidSessionConfig)?;
        let observed = self
            .last_monotonic_milliseconds
            .checked_add(elapsed_milliseconds)
            .ok_or(StratumV1Error::InvalidSessionConfig)?;
        if observed >= self.expires_at_monotonic_milliseconds {
            return Err(StratumV1Error::ExpiredCredentials);
        }
        Ok(Self {
            lease_id: self.lease_id.clone(),
            continuity_id: self.continuity_id.clone(),
            last_monotonic_milliseconds: observed,
            renew_at_monotonic_milliseconds: self.renew_at_monotonic_milliseconds,
            expires_at_monotonic_milliseconds: self.expires_at_monotonic_milliseconds,
        })
    }
}

fn bounded_session_expiry(
    lease_context: &StratumLeaseContext,
    now_unix_seconds: u64,
    lease_expires_at_unix_seconds: u64,
    challenge_expires_at_unix_seconds: u64,
) -> Result<u64, StratumV1Error> {
    let remaining_lease_seconds = lease_context
        .expires_at_monotonic_milliseconds
        .checked_sub(lease_context.last_monotonic_milliseconds)
        .ok_or(StratumV1Error::InvalidSessionConfig)?
        / 1_000;
    let expires_at = lease_expires_at_unix_seconds.min(challenge_expires_at_unix_seconds);
    if expires_at <= now_unix_seconds
        || expires_at.saturating_sub(now_unix_seconds) > MAXIMUM_SESSION_CREDENTIAL_SECONDS
        || expires_at.saturating_sub(now_unix_seconds) > remaining_lease_seconds
    {
        return Err(StratumV1Error::InvalidSessionConfig);
    }
    Ok(expires_at)
}
