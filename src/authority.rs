use std::{collections::HashSet, str::FromStr, sync::Arc, time::SystemTime};

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode, header::AUTHORIZATION},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use ring::hmac;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::{
    authority_descriptor::{AuthorityDescriptor, JwksDocument},
    challenge::{
        ActionPolicy, ActionReference, AllowedOrigins, ChallengeError, ClaimantKey,
        IssueChallengeCommand, RelyingServiceAudience, WorkChallengeDescriptor,
        WorkRequirementOverride, issue_challenge,
    },
};

pub use crate::authority_descriptor::AuthorityPublicConfig;

/// Backend-only header carrying the public service client identifier.
pub const CLIENT_ID_HEADER: &str = "bwg-client-id";
const MINIMUM_SERVICE_SECRET_LENGTH: usize = 32;
const MAXIMUM_SERVICE_SECRET_LENGTH: usize = 128;
const SERVICE_SECRET_VERIFIER_DOMAIN: &[u8] = b"BWG/0.1 service credential verifier";

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
    client_id: Arc<str>,
    secret_verifier: [u8; 32],
    environment: DeploymentEnvironment,
    relying_service_audience: RelyingServiceAudience,
    allowed_origins: AllowedOrigins,
    allowed_policies: Arc<[ActionPolicy]>,
}

impl ServiceCredential {
    /// Creates a verifier-only credential bound to one environment, audience, origins, and policy set.
    pub fn new(
        client_id: impl Into<Arc<str>>,
        secret: &str,
        environment: DeploymentEnvironment,
        relying_service_audience: String,
        allowed_origins: Vec<String>,
        allowed_policies: Vec<ActionPolicy>,
    ) -> Result<Self, AuthorityConfigError> {
        let client_id = client_id.into();
        if client_id.is_empty()
            || client_id.len() > 128
            || !client_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            return Err(AuthorityConfigError::InvalidClientId);
        }
        if !(MINIMUM_SERVICE_SECRET_LENGTH..=MAXIMUM_SERVICE_SECRET_LENGTH).contains(&secret.len())
            || !secret.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~')
            })
        {
            return Err(AuthorityConfigError::InvalidServiceSecret);
        }
        if allowed_policies.is_empty() {
            return Err(AuthorityConfigError::MissingPolicyScope);
        }

        Ok(Self {
            client_id,
            secret_verifier: service_secret_verifier(secret),
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
            .map(|credential| (credential.client_id.as_ref(), credential.secret_verifier))
            .collect::<HashSet<_>>();
        if unique_credentials.len() != credentials.len() {
            return Err(AuthorityConfigError::DuplicateCredential);
        }

        let descriptor = public.descriptor();
        let jwks = descriptor.jwks();
        Ok(Self {
            credentials: credentials.into(),
            descriptor,
            jwks,
        })
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
        let maybe_credential = self
            .credentials
            .iter()
            .filter(|credential| credential.client_id.as_ref() == client_id)
            .find(|credential| credential.verify_secret(secret));
        let Some(credential) = maybe_credential else {
            return Err(ApiError::Unauthorized);
        };
        Ok(credential)
    }
}

#[derive(Clone)]
struct AuthorityState {
    config: Config,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CreateChallengeRequest {
    pub action_policy: String,
    pub action_reference: String,
    pub claimant_key: String,
    #[serde(default, rename = "overrides", skip_serializing_if = "Option::is_none")]
    pub maybe_overrides: Option<ChallengeOverridesRequest>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ChallengeOverridesRequest {
    pub expected_hashes: String,
}

/// Builds the versioned Gate Authority HTTP interface.
pub fn router(config: Config) -> Router {
    Router::new()
        .route("/v0/challenges", post(create_challenge))
        .route(
            "/.well-known/pow-gate-configuration",
            get(authority_descriptor),
        )
        .route("/.well-known/jwks.json", get(authority_jwks))
        .with_state(AuthorityState { config })
}

async fn authority_descriptor(State(state): State<AuthorityState>) -> Json<AuthorityDescriptor> {
    Json(state.config.descriptor)
}

async fn authority_jwks(State(state): State<AuthorityState>) -> Json<JwksDocument> {
    Json(state.config.jwks)
}

async fn create_challenge(
    State(state): State<AuthorityState>,
    headers: HeaderMap,
    Json(request): Json<CreateChallengeRequest>,
) -> Result<(StatusCode, Json<WorkChallengeDescriptor>), ApiError> {
    let credential = state.config.authenticate(&headers)?;
    let action_policy = ActionPolicy::parse(&request.action_policy)?;
    if !credential.permits(action_policy) {
        return Err(ApiError::PolicyNotPermitted);
    }
    let command = IssueChallengeCommand {
        action_policy,
        action_reference: ActionReference::try_from(request.action_reference)?,
        claimant_key: ClaimantKey::try_from(request.claimant_key)?,
        relying_service_audience: credential.relying_service_audience.clone(),
        allowed_origins: credential.allowed_origins.clone(),
        maybe_work_requirement_override: request
            .maybe_overrides
            .map(|overrides| WorkRequirementOverride::expected_hashes(overrides.expected_hashes))
            .transpose()?,
    };
    let issued_at_unix_seconds = SystemTime::UNIX_EPOCH
        .elapsed()
        .map_err(|_| ApiError::InternalTime)?
        .as_secs();
    let descriptor = issue_challenge(
        command,
        format!("challenge_{}", Uuid::new_v4().simple()),
        issued_at_unix_seconds,
    )?;

    Ok((StatusCode::CREATED, Json(descriptor)))
}

enum ApiError {
    Unauthorized,
    PolicyNotPermitted,
    InvalidChallenge(ChallengeError),
    InternalTime,
}

impl From<ChallengeError> for ApiError {
    fn from(error: ChallengeError) -> Self {
        Self::InvalidChallenge(error)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code) = match self {
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            Self::PolicyNotPermitted => (StatusCode::FORBIDDEN, "policy_not_permitted"),
            Self::InvalidChallenge(ChallengeError::UnknownActionPolicy) => {
                (StatusCode::BAD_REQUEST, "unknown_action_policy")
            }
            Self::InvalidChallenge(
                ChallengeError::OverrideNotPermitted | ChallengeError::OverrideOutsideBounds,
            ) => (StatusCode::BAD_REQUEST, "invalid_policy_override"),
            Self::InvalidChallenge(_) => (StatusCode::BAD_REQUEST, "invalid_challenge_request"),
            Self::InternalTime => (StatusCode::INTERNAL_SERVER_ERROR, "internal_error"),
        };

        (status, Json(ErrorResponse { error: code })).into_response()
    }
}

#[derive(Serialize)]
struct ErrorResponse {
    error: &'static str,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AuthorityConfigError {
    #[error("deployment environment must be development, staging, or production")]
    InvalidEnvironment,
    #[error("client identifier is invalid")]
    InvalidClientId,
    #[error("service secret must be a 32-128 character high-entropy token")]
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
