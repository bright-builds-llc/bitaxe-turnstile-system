use std::{
    collections::{HashMap, HashSet},
    str::FromStr,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime},
};

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{
        HeaderMap, StatusCode,
        header::{AUTHORIZATION, RETRY_AFTER},
    },
    response::{
        IntoResponse, Response, Sse,
        sse::{Event, KeepAlive},
    },
    routing::{get, post},
};
use ring::hmac;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio_stream::{
    Stream, StreamExt as _,
    wrappers::{BroadcastStream, errors::BroadcastStreamRecvError},
};
use uuid::Uuid;

use crate::{
    authority_descriptor::{AuthorityDescriptor, JwksDocument},
    challenge::{
        ActionPolicy, ActionReference, AllowedOrigins, ChallengeError, ChallengeId, ClaimantKey,
        IssueChallengeCommand, RelyingServiceAudience, WorkChallengeDescriptor,
        WorkRequirementOverride, issue_challenge,
    },
    progress::{
        AcceptedWorkAcknowledgement, AcceptedWorkEvent, ProgressError, ProgressService,
        WorkSessionId,
    },
    service_auth::{ServiceClientId, ServiceSecret},
};

pub use crate::authority_descriptor::AuthorityPublicConfig;

#[cfg(test)]
mod tests;

/// Backend-only header carrying the public service client identifier.
pub const CLIENT_ID_HEADER: &str = "bwg-client-id";
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
    progress: ProgressService,
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

        let descriptor = public.descriptor();
        let jwks = descriptor.jwks();
        Ok(Self {
            credentials: credentials.into(),
            descriptor,
            jwks,
            authentication_throttle: AuthenticationThrottle::default(),
            progress: ProgressService::default(),
        })
    }

    /// Returns the in-process Pool Adapter tracer port used by this implementation slice.
    pub fn simulated_pool_adapter(&self) -> SimulatedPoolAdapter {
        SimulatedPoolAdapter {
            progress: self.progress.clone(),
        }
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

/// In-process adapter port that exercises the future authenticated gRPC boundary.
#[derive(Clone)]
pub struct SimulatedPoolAdapter {
    progress: ProgressService,
}

impl SimulatedPoolAdapter {
    /// Binds one Work Session to its opaque challenge.
    pub fn register_session(
        &self,
        challenge_id: &ChallengeId,
        session_id: WorkSessionId,
    ) -> Result<(), ProgressError> {
        self.progress.register_session(challenge_id, session_id)
    }

    /// Reports one target-qualified accepted result with stable replay acknowledgement.
    pub fn report(
        &self,
        event: AcceptedWorkEvent,
    ) -> Result<AcceptedWorkAcknowledgement, ProgressError> {
        self.progress.report(event)
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
        .route(
            "/v0/challenges/{challenge_id}/events",
            get(challenge_progress),
        )
        .with_state(AuthorityState { config })
}

async fn authority_descriptor(State(state): State<AuthorityState>) -> Json<AuthorityDescriptor> {
    Json(state.config.descriptor)
}

async fn authority_jwks(State(state): State<AuthorityState>) -> Json<JwksDocument> {
    Json(state.config.jwks)
}

async fn challenge_progress(
    State(state): State<AuthorityState>,
    Path(challenge_id): Path<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, axum::Error>>>, ApiError> {
    let challenge_id = ChallengeId::try_from(challenge_id)?;
    let (snapshot, receiver) = state.config.progress.subscribe(&challenge_id)?;
    let initial = tokio_stream::once(
        Event::default()
            .event("verified_progress")
            .json_data(snapshot),
    );
    let live = BroadcastStream::new(receiver).filter_map(|result| match result {
        Ok(update) => Some(
            Event::default()
                .event("verified_progress")
                .json_data(update),
        ),
        Err(BroadcastStreamRecvError::Lagged(skipped)) => Some(Ok(Event::default()
            .event("resync_required")
            .data(format!("skipped {skipped} progress updates")))),
    });
    Ok(Sse::new(initial.chain(live)).keep_alive(KeepAlive::default()))
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
    state.config.progress.register_challenge(
        ChallengeId::try_from(descriptor.challenge_id().to_owned())?,
        descriptor.required_work(),
    )?;

    Ok((StatusCode::CREATED, Json(descriptor)))
}

enum ApiError {
    Unauthorized,
    TooManyAuthenticationAttempts,
    PolicyNotPermitted,
    InvalidChallenge(ChallengeError),
    InternalTime,
    InternalState,
    InvalidProgress(ProgressError),
}

impl From<ChallengeError> for ApiError {
    fn from(error: ChallengeError) -> Self {
        Self::InvalidChallenge(error)
    }
}

impl From<ProgressError> for ApiError {
    fn from(error: ProgressError) -> Self {
        Self::InvalidProgress(error)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        if matches!(self, Self::TooManyAuthenticationAttempts) {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                [(RETRY_AFTER, "60")],
                Json(ErrorResponse {
                    error: "too_many_authentication_attempts",
                }),
            )
                .into_response();
        }
        let (status, code) = match self {
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            Self::TooManyAuthenticationAttempts => unreachable!("handled above"),
            Self::PolicyNotPermitted => (StatusCode::FORBIDDEN, "policy_not_permitted"),
            Self::InvalidChallenge(ChallengeError::UnknownActionPolicy) => {
                (StatusCode::BAD_REQUEST, "unknown_action_policy")
            }
            Self::InvalidChallenge(
                ChallengeError::OverrideNotPermitted | ChallengeError::OverrideOutsideBounds,
            ) => (StatusCode::BAD_REQUEST, "invalid_policy_override"),
            Self::InvalidChallenge(_) => (StatusCode::BAD_REQUEST, "invalid_challenge_request"),
            Self::InvalidProgress(ProgressError::UnknownChallenge) => {
                (StatusCode::NOT_FOUND, "unknown_challenge")
            }
            Self::InvalidProgress(_) => (StatusCode::BAD_REQUEST, "invalid_progress_request"),
            Self::InternalTime | Self::InternalState => {
                (StatusCode::INTERNAL_SERVER_ERROR, "internal_error")
            }
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
