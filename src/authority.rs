use std::{sync::Arc, time::SystemTime};

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode, header::AUTHORIZATION},
    response::{IntoResponse, Response},
    routing::post,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::challenge::{
    ActionPolicy, ActionReference, ChallengeError, ClaimantKey, IssueChallengeCommand,
    WorkChallengeDescriptor, issue_challenge,
};

/// Secret server-side configuration for the initial authenticated issuance seam.
#[derive(Clone)]
pub struct Config {
    service_credential: Arc<str>,
}

impl Config {
    pub fn new(service_credential: impl Into<Arc<str>>) -> Self {
        Self {
            service_credential: service_credential.into(),
        }
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
}

/// Builds the versioned Gate Authority HTTP interface.
pub fn router(config: Config) -> Router {
    Router::new()
        .route("/v0/challenges", post(create_challenge))
        .with_state(AuthorityState { config })
}

async fn create_challenge(
    State(state): State<AuthorityState>,
    headers: HeaderMap,
    Json(request): Json<CreateChallengeRequest>,
) -> Result<(StatusCode, Json<WorkChallengeDescriptor>), ApiError> {
    authenticate(&headers, &state.config)?;

    let command = IssueChallengeCommand {
        action_policy: ActionPolicy::parse(&request.action_policy)?,
        action_reference: ActionReference::try_from(request.action_reference)?,
        claimant_key: ClaimantKey::try_from(request.claimant_key)?,
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

fn authenticate(headers: &HeaderMap, config: &Config) -> Result<(), ApiError> {
    let maybe_authorization = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    let expected = format!("Bearer {}", config.service_credential);

    if maybe_authorization != Some(expected.as_str()) {
        return Err(ApiError::Unauthorized);
    }

    Ok(())
}

enum ApiError {
    Unauthorized,
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
            Self::InvalidChallenge(ChallengeError::UnknownActionPolicy) => {
                (StatusCode::BAD_REQUEST, "unknown_action_policy")
            }
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
