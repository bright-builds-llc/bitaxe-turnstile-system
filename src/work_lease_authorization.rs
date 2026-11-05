//! Work Lease Authority signing for `bwg-worker-lease-authorization/0.2`.
//!
//! ADR-0093 fixes the compact JWS; ADR-0106 lets the Gate Authority issue it. The
//! bytes must equal the TypeScript signer's, which the shared vectors prove.

use std::sync::Arc;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::{
    digest,
    signature::{self, KeyPair as _},
};
use serde::Serialize;
use thiserror::Error;

#[cfg(test)]
mod tests;

/// Canonical signed Work Lease authorization profile.
pub const WORKER_LEASE_AUTHORIZATION_PROFILE: &str = "bwg-worker-lease-authorization/0.2";
/// Required compact-JWS protected-header type.
pub const WORKER_LEASE_AUTHORIZATION_TYPE: &str = "bwg-worker-lease-authorization+jws";
/// Controller profile, which is also the Work Lease Authority audience.
pub const WORKER_CONTROLLER_PROTOCOL_VERSION: &str = "bwg-worker-controller/0.4";
/// Controller 0.4 authorization-field byte limit.
pub const MAXIMUM_WORKER_LEASE_AUTHORIZATION_BYTES: usize = 512;
/// Device lease length the Authority grants, the Controller 0.4 maximum.
pub const WORKER_LEASE_DURATION_MILLISECONDS: u64 = 60_000;
/// Device renewal point the Authority grants, the Controller 0.4 maximum.
pub const WORKER_LEASE_RENEW_AFTER_MILLISECONDS: u64 = 20_000;

const MAXIMUM_IDENTIFIER_LENGTH: usize = 128;
const MAXIMUM_STRATUM_SECRET_LENGTH: usize = 512;
const SIGNATURE_ALGORITHM: &str = "Ed25519";

/// Rejections from building or signing a Work Lease authorization.
#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum WorkLeaseAuthorizationError {
    #[error("Work Lease Authority key is invalid")]
    InvalidSigningKey,
    #[error("Work Lease Authority issuer label is invalid")]
    InvalidIssuer,
    #[error("control-session digest is invalid")]
    InvalidControlSessionBinding,
    #[error("Work Lease authorization sequence is invalid")]
    InvalidSequence,
    #[error("Work Lease identifier is invalid")]
    InvalidIdentifier,
    #[error("Stratum V1 grant fields are invalid")]
    InvalidStratum,
    #[error("Work Lease authorization exceeds the Controller field")]
    AuthorizationTooLarge,
    #[error("Work Lease authorization could not be serialized")]
    SerializationFailed,
}

/// Possession-derived control-session digest from ADR-0093.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlSessionBinding(String);

impl TryFrom<String> for ControlSessionBinding {
    type Error = WorkLeaseAuthorizationError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.len() != 43 || !value.bytes().all(is_base64url_byte) {
            return Err(WorkLeaseAuthorizationError::InvalidControlSessionBinding);
        }
        Ok(Self(value))
    }
}

impl ControlSessionBinding {
    /// Returns the digest, which also names the lease clock's continuity.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Durable non-zero per-key authorization sequence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuthorizationSequence(u64);

impl TryFrom<u64> for AuthorizationSequence {
    type Error = WorkLeaseAuthorizationError;

    fn try_from(value: u64) -> Result<Self, Self::Error> {
        if value == 0 {
            return Err(WorkLeaseAuthorizationError::InvalidSequence);
        }
        Ok(Self(value))
    }
}

/// Lease-scoped Stratum V1 credentials the Worker uses for one grant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkerStratumV1 {
    endpoint: String,
    password: String,
    username: String,
}

impl WorkerStratumV1 {
    /// Validates the endpoint shape and credential bounds Controller 0.4 accepts.
    pub fn new(
        endpoint: String,
        username: String,
        password: String,
    ) -> Result<Self, WorkLeaseAuthorizationError> {
        if !valid_stratum_endpoint(&endpoint)
            || !valid_stratum_secret(&username)
            || !valid_stratum_secret(&password)
        {
            return Err(WorkLeaseAuthorizationError::InvalidStratum);
        }
        Ok(Self {
            endpoint,
            password,
            username,
        })
    }
}

/// Validates a `stratum+tcp://host:port/` endpoint with no user info or query.
pub fn valid_stratum_endpoint(value: &str) -> bool {
    let Some(authority) = value
        .strip_prefix("stratum+tcp://")
        .and_then(|rest| rest.strip_suffix('/'))
    else {
        return false;
    };
    let Some((host, port)) = authority.rsplit_once(':') else {
        return false;
    };
    !host.is_empty()
        && host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
        && port.bytes().all(|byte| byte.is_ascii_digit())
        && !port.starts_with('0')
        && port.parse::<u16>().is_ok_and(|port| port > 0)
}

/// Device grant returned by Start and Resume.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerLeaseGrant {
    protocol_version: &'static str,
    lease_id: String,
    challenge_id: String,
    authorization: String,
    duration_milliseconds: u64,
    renew_after_milliseconds: u64,
    stratum: WorkerStratumV1,
}

impl WorkerLeaseGrant {
    /// Returns the signed opaque Controller authorization.
    pub fn authorization(&self) -> &str {
        &self.authorization
    }
}

/// Device renewal returned by Renew.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerLeaseRenewal {
    protocol_version: &'static str,
    lease_id: String,
    authorization: String,
    duration_milliseconds: u64,
    renew_after_milliseconds: u64,
}

impl WorkerLeaseRenewal {
    /// Returns the signed opaque Controller authorization.
    pub fn authorization(&self) -> &str {
        &self.authorization
    }
}

/// Ed25519 Work Lease Authority signer, separate from every Gate Pass key.
#[derive(Clone)]
pub struct WorkLeaseAuthoritySigner {
    kid: String,
    issuer: String,
    key_pair: Arc<signature::Ed25519KeyPair>,
}

impl WorkLeaseAuthoritySigner {
    /// Imports a base64url Ed25519 seed under a key ID and issuer label.
    pub fn from_seed_base64url(
        kid: String,
        issuer: String,
        seed_base64url: &str,
    ) -> Result<Self, WorkLeaseAuthorizationError> {
        if !valid_key_id(&kid) {
            return Err(WorkLeaseAuthorizationError::InvalidSigningKey);
        }
        if !valid_issuer(&issuer) {
            return Err(WorkLeaseAuthorizationError::InvalidIssuer);
        }
        let seed = URL_SAFE_NO_PAD
            .decode(seed_base64url)
            .map_err(|_| WorkLeaseAuthorizationError::InvalidSigningKey)?;
        let key_pair = signature::Ed25519KeyPair::from_seed_unchecked(&seed)
            .map_err(|_| WorkLeaseAuthorizationError::InvalidSigningKey)?;
        Ok(Self {
            kid,
            issuer,
            key_pair: Arc::new(key_pair),
        })
    }

    /// Returns the key ID that owns the durable sequence.
    pub fn kid(&self) -> &str {
        &self.kid
    }

    /// Returns the raw Ed25519 public key for role-separation checks.
    pub fn public_key(&self) -> &[u8] {
        self.key_pair.public_key().as_ref()
    }

    /// Signs a Start or Resume grant for the active Challenge.
    pub fn sign_grant(
        &self,
        lease_id: String,
        challenge_id: String,
        stratum: WorkerStratumV1,
        control_session: &ControlSessionBinding,
        sequence: AuthorizationSequence,
    ) -> Result<WorkerLeaseGrant, WorkLeaseAuthorizationError> {
        validate_identifier(&lease_id)?;
        validate_identifier(&challenge_id)?;
        let request = GrantRequest {
            challenge_id: &challenge_id,
            duration_milliseconds: WORKER_LEASE_DURATION_MILLISECONDS,
            lease_id: &lease_id,
            protocol_version: WORKER_CONTROLLER_PROTOCOL_VERSION,
            renew_after_milliseconds: WORKER_LEASE_RENEW_AFTER_MILLISECONDS,
            stratum: &stratum,
        };
        let authorization =
            self.sign("start", &challenge_id, &request, control_session, sequence)?;
        Ok(WorkerLeaseGrant {
            protocol_version: WORKER_CONTROLLER_PROTOCOL_VERSION,
            lease_id,
            challenge_id,
            authorization,
            duration_milliseconds: WORKER_LEASE_DURATION_MILLISECONDS,
            renew_after_milliseconds: WORKER_LEASE_RENEW_AFTER_MILLISECONDS,
            stratum,
        })
    }

    /// Signs a renewal of the exact active lease.
    pub fn sign_renewal(
        &self,
        lease_id: String,
        active_challenge_id: &str,
        control_session: &ControlSessionBinding,
        sequence: AuthorizationSequence,
    ) -> Result<WorkerLeaseRenewal, WorkLeaseAuthorizationError> {
        validate_identifier(&lease_id)?;
        validate_identifier(active_challenge_id)?;
        let request = RenewalRequest {
            duration_milliseconds: WORKER_LEASE_DURATION_MILLISECONDS,
            lease_id: &lease_id,
            protocol_version: WORKER_CONTROLLER_PROTOCOL_VERSION,
            renew_after_milliseconds: WORKER_LEASE_RENEW_AFTER_MILLISECONDS,
        };
        let authorization = self.sign(
            "renew",
            active_challenge_id,
            &request,
            control_session,
            sequence,
        )?;
        Ok(WorkerLeaseRenewal {
            protocol_version: WORKER_CONTROLLER_PROTOCOL_VERSION,
            lease_id,
            authorization,
            duration_milliseconds: WORKER_LEASE_DURATION_MILLISECONDS,
            renew_after_milliseconds: WORKER_LEASE_RENEW_AFTER_MILLISECONDS,
        })
    }

    fn sign<Request: Serialize>(
        &self,
        operation: &'static str,
        active_challenge_id: &str,
        request: &Request,
        control_session: &ControlSessionBinding,
        sequence: AuthorizationSequence,
    ) -> Result<String, WorkLeaseAuthorizationError> {
        let digest_input = RequestDigestInput {
            active_challenge_id,
            audience: WORKER_CONTROLLER_PROTOCOL_VERSION,
            issuer: &self.issuer,
            operation,
            profile: WORKER_LEASE_AUTHORIZATION_PROFILE,
            request,
        };
        let request_digest = digest::digest(&digest::SHA256, &canonical_bytes(&digest_input)?);
        let sequence = sequence.0.to_string();
        let payload = Payload {
            control_session_binding_sha256: control_session.as_str(),
            operation,
            request_sha256: &URL_SAFE_NO_PAD.encode(request_digest.as_ref()),
            sequence: &sequence,
        };
        let header = Header {
            alg: SIGNATURE_ALGORITHM,
            kid: &self.kid,
            typ: WORKER_LEASE_AUTHORIZATION_TYPE,
        };
        let signing_input = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(canonical_bytes(&header)?),
            URL_SAFE_NO_PAD.encode(canonical_bytes(&payload)?)
        );
        let signature = self.key_pair.sign(signing_input.as_bytes());
        let compact = format!(
            "{signing_input}.{}",
            URL_SAFE_NO_PAD.encode(signature.as_ref())
        );
        if compact.len() > MAXIMUM_WORKER_LEASE_AUTHORIZATION_BYTES {
            return Err(WorkLeaseAuthorizationError::AuthorizationTooLarge);
        }
        Ok(compact)
    }
}

// Every signed object below declares its fields in code-point order, so serde's
// compact output equals the TypeScript `canonicalJson` bytes for these ASCII keys.

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GrantRequest<'a> {
    challenge_id: &'a str,
    duration_milliseconds: u64,
    lease_id: &'a str,
    protocol_version: &'a str,
    renew_after_milliseconds: u64,
    stratum: &'a WorkerStratumV1,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RenewalRequest<'a> {
    duration_milliseconds: u64,
    lease_id: &'a str,
    protocol_version: &'a str,
    renew_after_milliseconds: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RequestDigestInput<'a, Request> {
    active_challenge_id: &'a str,
    audience: &'a str,
    issuer: &'a str,
    operation: &'a str,
    profile: &'a str,
    request: &'a Request,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Payload<'a> {
    control_session_binding_sha256: &'a str,
    operation: &'a str,
    request_sha256: &'a str,
    sequence: &'a str,
}

#[derive(Serialize)]
struct Header<'a> {
    alg: &'a str,
    kid: &'a str,
    typ: &'a str,
}

fn canonical_bytes<T: Serialize>(value: &T) -> Result<Vec<u8>, WorkLeaseAuthorizationError> {
    serde_json::to_vec(value).map_err(|_| WorkLeaseAuthorizationError::SerializationFailed)
}

fn validate_identifier(value: &str) -> Result<(), WorkLeaseAuthorizationError> {
    if value.is_empty()
        || value.len() > MAXIMUM_IDENTIFIER_LENGTH
        || !value.bytes().all(is_base64url_byte)
    {
        return Err(WorkLeaseAuthorizationError::InvalidIdentifier);
    }
    Ok(())
}

fn valid_key_id(value: &str) -> bool {
    (1..=32).contains(&value.len()) && value.bytes().all(is_base64url_byte)
}

fn valid_issuer(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| is_base64url_byte(byte) || byte == b'.')
}

fn valid_stratum_secret(value: &str) -> bool {
    !value.is_empty() && value.chars().count() <= MAXIMUM_STRATUM_SECRET_LENGTH
}

fn is_base64url_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')
}
