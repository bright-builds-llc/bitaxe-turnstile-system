use std::{
    collections::{HashMap, HashSet},
    str::FromStr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::http::{HeaderMap, header::AUTHORIZATION};
use ring::hmac;
use thiserror::Error;

use crate::{
    authority_descriptor::{AuthorityDescriptor, JwksDocument},
    challenge::{ActionPolicy, AllowedOrigins, ChallengeId, RelyingServiceAudience},
    crypto_profile::{AuthorityKeySet, AuthoritySigningKey},
    service_auth::{ServiceClientId, ServiceSecret},
};

mod http;
use http::ApiError;
pub(crate) use http::CreateChallengeRequest;
pub use http::router;

pub use crate::authority_application::{
    AuthorityApplication, AuthorityApplicationError, IssuanceProcessingOutcome, IssuanceWorkerId,
    SimulatedPoolAdapter,
};
pub use crate::authority_descriptor::AuthorityPublicConfig;

#[cfg(test)]
mod tests;

/// Backend-only header carrying the public service client identifier.
pub const CLIENT_ID_HEADER: &str = "bwg-client-id";
/// Claimant-signed proof header required for read-only issuance lookup.
pub const CLAIMANT_PROOF_HEADER: &str = "bwg-claimant-proof";
const SERVICE_SECRET_VERIFIER_DOMAIN: &[u8] = b"BWG/0.1 service credential verifier";
const MAXIMUM_FAILED_AUTHENTICATIONS: u32 = 5;
const AUTHENTICATION_THROTTLE_WINDOW: Duration = Duration::from_secs(60);

#[derive(Clone, Default)]
struct AuthenticationThrottle {
    failures: Arc<Mutex<HashMap<String, FailureWindow>>>,
}

struct FailureWindow {
    started_at: Instant,
    failures: u32,
}

impl FailureWindow {
    fn new(now: Instant) -> Self {
        Self {
            started_at: now,
            failures: 0,
        }
    }

    fn is_expired(&self, now: Instant) -> bool {
        now.duration_since(self.started_at) >= AUTHENTICATION_THROTTLE_WINDOW
    }

    fn is_limited(&self) -> bool {
        self.failures >= MAXIMUM_FAILED_AUTHENTICATIONS
    }

    fn record_failure(&mut self, now: Instant) {
        if self.is_expired(now) {
            *self = Self::new(now);
        }
        self.failures += 1;
    }
}

impl AuthenticationThrottle {
    fn check(&self, client_id: &str, now: Instant) -> Result<(), ApiError> {
        let mut failures = self.failures.lock().map_err(|_| ApiError::InternalState)?;
        if failures
            .get(client_id)
            .is_some_and(|window| window.is_expired(now))
        {
            failures.remove(client_id);
        }
        if failures
            .get(client_id)
            .is_some_and(FailureWindow::is_limited)
        {
            return Err(ApiError::TooManyAuthenticationAttempts);
        }
        Ok(())
    }

    fn record_failure(&self, client_id: &str, now: Instant) -> Result<(), ApiError> {
        let mut failures = self.failures.lock().map_err(|_| ApiError::InternalState)?;
        let window = failures
            .entry(client_id.to_owned())
            .or_insert_with(|| FailureWindow::new(now));
        window.record_failure(now);
        Ok(())
    }

    fn clear(&self, client_id: &str) -> Result<(), ApiError> {
        self.failures
            .lock()
            .map_err(|_| ApiError::InternalState)?
            .remove(client_id);
        Ok(())
    }
}

/// An isolated Gate Authority deployment environment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeploymentEnvironment {
    Development,
    Staging,
    Production,
}

impl FromStr for DeploymentEnvironment {
    type Err = AuthorityConfigError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "development" => Ok(Self::Development),
            "staging" => Ok(Self::Staging),
            "production" => Ok(Self::Production),
            _ => Err(AuthorityConfigError::InvalidEnvironment),
        }
    }
}

/// A high-entropy backend credential stored as a verifier and scoped to policies.
#[derive(Clone)]
pub struct ServiceCredential {
    client_id: ServiceClientId,
    secret_verifier: [u8; 32],
    environment: DeploymentEnvironment,
    relying_service_audience: RelyingServiceAudience,
    allowed_origins: AllowedOrigins,
    allowed_policies: Arc<[ActionPolicy]>,
}

impl ServiceCredential {
    /// Creates a verifier-only credential bound to one environment, audience, origins, and policy set.
    pub fn new(
        client_id: impl Into<String>,
        secret: &str,
        environment: DeploymentEnvironment,
        relying_service_audience: String,
        allowed_origins: Vec<String>,
        allowed_policies: Vec<ActionPolicy>,
    ) -> Result<Self, AuthorityConfigError> {
        let client_id = ServiceClientId::try_from(client_id.into())
            .map_err(|_| AuthorityConfigError::InvalidClientId)?;
        let secret = ServiceSecret::try_from(secret.to_owned())
            .map_err(|_| AuthorityConfigError::InvalidServiceSecret)?;
        if allowed_policies.is_empty() {
            return Err(AuthorityConfigError::MissingPolicyScope);
        }

        Ok(Self {
            client_id,
            secret_verifier: service_secret_verifier(secret.expose_secret()),
            environment,
            relying_service_audience: RelyingServiceAudience::try_from(relying_service_audience)
                .map_err(|_| AuthorityConfigError::InvalidRelyingServiceAudience)?,
            allowed_origins: AllowedOrigins::try_from(allowed_origins)
                .map_err(|_| AuthorityConfigError::InvalidAllowedOrigins)?,
            allowed_policies: allowed_policies.into(),
        })
    }

    fn verify_secret(&self, secret: &str) -> bool {
        hmac::verify(
            &service_secret_verifier_key(),
            secret.as_bytes(),
            &self.secret_verifier,
        )
        .is_ok()
    }

    fn permits(&self, action_policy: ActionPolicy) -> bool {
        self.allowed_policies.contains(&action_policy)
    }
}

/// Secret and public server-side configuration for the Gate Authority.
#[derive(Clone)]
pub struct Config {
    credentials: Arc<[ServiceCredential]>,
    descriptor: AuthorityDescriptor,
    jwks: JwksDocument,
    authentication_throttle: AuthenticationThrottle,
    authority_keys: AuthorityKeySet,
    maybe_signer: Option<AuthoritySigningKey>,
}

impl Config {
    /// Builds an Authority configuration after rejecting missing, duplicate, or cross-environment credentials.
    pub fn new(
        environment: DeploymentEnvironment,
        credentials: Vec<ServiceCredential>,
        public: AuthorityPublicConfig,
    ) -> Result<Self, AuthorityConfigError> {
        if credentials.is_empty() {
            return Err(AuthorityConfigError::MissingCredentials);
        }
        if credentials
            .iter()
            .any(|credential| credential.environment != environment)
        {
            return Err(AuthorityConfigError::EnvironmentMismatch);
        }
        let unique_credentials = credentials
            .iter()
            .map(|credential| (credential.client_id.as_str(), credential.secret_verifier))
            .collect::<HashSet<_>>();
        if unique_credentials.len() != credentials.len() {
            return Err(AuthorityConfigError::DuplicateCredential);
        }

        let authority_keys = public.authority_keys().clone();
        let descriptor = public.descriptor();
        let jwks = descriptor.jwks();
        Ok(Self {
            credentials: credentials.into(),
            descriptor,
            jwks,
            authentication_throttle: AuthenticationThrottle::default(),
            authority_keys,
            maybe_signer: None,
        })
    }

    /// Configures the active Ed25519 signer after matching it to the published JWKS.
    pub fn with_signing_key_seed(
        mut self,
        kid: String,
        seed_base64url: &str,
    ) -> Result<Self, AuthorityConfigError> {
        let signer =
            AuthoritySigningKey::from_seed_base64url(kid, seed_base64url, &self.authority_keys)
                .map_err(|_| AuthorityConfigError::InvalidSigningKey)?;
        self.maybe_signer = Some(signer);
        Ok(self)
    }

    pub(crate) fn issuer(&self) -> &str {
        self.descriptor.issuer()
    }

    pub(crate) fn maybe_signer(&self) -> Option<AuthoritySigningKey> {
        self.maybe_signer.clone()
    }

    pub(crate) fn issuance_lookup_url(&self, challenge_id: &ChallengeId) -> String {
        self.descriptor.gate_pass_url(challenge_id.as_str())
    }

    fn authenticate(&self, headers: &HeaderMap) -> Result<&ServiceCredential, ApiError> {
        let maybe_client_id = headers
            .get(CLIENT_ID_HEADER)
            .and_then(|value| value.to_str().ok());
        let maybe_secret = headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "));
        let (Some(client_id), Some(secret)) = (maybe_client_id, maybe_secret) else {
            return Err(ApiError::Unauthorized);
        };
        if !self
            .credentials
            .iter()
            .any(|credential| credential.client_id.as_str() == client_id)
        {
            return Err(ApiError::Unauthorized);
        }
        let now = Instant::now();
        self.authentication_throttle.check(client_id, now)?;
        let maybe_credential = self
            .credentials
            .iter()
            .filter(|credential| credential.client_id.as_str() == client_id)
            .find(|credential| credential.verify_secret(secret));
        let Some(credential) = maybe_credential else {
            self.authentication_throttle
                .record_failure(client_id, now)?;
            return Err(ApiError::Unauthorized);
        };
        self.authentication_throttle.clear(client_id)?;
        Ok(credential)
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AuthorityConfigError {
    #[error("deployment environment must be development, staging, or production")]
    InvalidEnvironment,
    #[error("client identifier is invalid")]
    InvalidClientId,
    #[error("service secret must be a diverse 43-128 character base64url token")]
    InvalidServiceSecret,
    #[error("service credential needs at least one Action Policy scope")]
    MissingPolicyScope,
    #[error("service credential needs a valid HTTPS Relying Service audience")]
    InvalidRelyingServiceAudience,
    #[error("service credential needs at least one unique HTTPS browser origin")]
    InvalidAllowedOrigins,
    #[error("Gate Authority needs at least one service credential")]
    MissingCredentials,
    #[error("service credential environment does not match the Authority")]
    EnvironmentMismatch,
    #[error("service credential verifier is duplicated")]
    DuplicateCredential,
    #[error("Authority signing key does not match the published JWKS")]
    InvalidSigningKey,
}

fn service_secret_verifier(secret: &str) -> [u8; 32] {
    let tag = hmac::sign(&service_secret_verifier_key(), secret.as_bytes());
    let mut verifier = [0_u8; 32];
    verifier.copy_from_slice(tag.as_ref());
    verifier
}

fn service_secret_verifier_key() -> hmac::Key {
    hmac::Key::new(hmac::HMAC_SHA256, SERVICE_SECRET_VERIFIER_DOMAIN)
}
