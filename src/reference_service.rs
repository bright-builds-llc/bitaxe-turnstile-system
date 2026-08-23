use std::sync::Arc;

use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    authority::CreateChallengeRequest,
    challenge::{ActionPolicy, WorkChallengeDescriptor},
};

/// Server-only configuration for the reference account-creation integration.
#[derive(Clone)]
pub struct Config {
    authority_base_url: Arc<str>,
    service_credential: Arc<str>,
}

impl Config {
    pub fn new(
        authority_base_url: impl Into<Arc<str>>,
        service_credential: impl Into<Arc<str>>,
    ) -> Self {
        Self {
            authority_base_url: authority_base_url.into(),
            service_credential: service_credential.into(),
        }
    }
}

#[derive(Clone)]
struct ReferenceServiceState {
    config: Config,
    http_client: reqwest::Client,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BrowserChallengeRequest {
    claimant_key: String,
}

/// Builds the browser-facing reference account-creation interface.
pub fn router(config: Config) -> Router {
    Router::new()
        .route(
            "/account-creation/challenge",
            post(create_account_challenge),
        )
        .with_state(ReferenceServiceState {
            config,
            http_client: reqwest::Client::new(),
        })
}

async fn create_account_challenge(
    State(state): State<ReferenceServiceState>,
    Json(request): Json<BrowserChallengeRequest>,
) -> Result<(StatusCode, Json<WorkChallengeDescriptor>), ReferenceServiceError> {
    let authority_request = CreateChallengeRequest {
        action_policy: ActionPolicy::ACCOUNT_CREATION_LIGHT_V1.to_owned(),
        action_reference: format!("action_{}", Uuid::new_v4().simple()),
        claimant_key: request.claimant_key,
    };
    let response = state
        .http_client
        .post(format!(
            "{}/v0/challenges",
            state.config.authority_base_url.trim_end_matches('/')
        ))
        .bearer_auth(state.config.service_credential.as_ref())
        .json(&authority_request)
        .send()
        .await
        .map_err(|error| {
            tracing::warn!(
                is_connect = error.is_connect(),
                is_timeout = error.is_timeout(),
                "Gate Authority challenge request failed"
            );
            ReferenceServiceError::AuthorityUnavailable
        })?;

    let authority_status = response.status();
    if authority_status != reqwest::StatusCode::CREATED {
        tracing::warn!(
            %authority_status,
            "Gate Authority rejected the reference challenge request"
        );
        return Err(ReferenceServiceError::AuthorityRejected);
    }

    let descriptor = response.json().await.map_err(|error| {
        tracing::warn!(
            is_decode = error.is_decode(),
            "Gate Authority returned an invalid challenge descriptor"
        );
        ReferenceServiceError::InvalidAuthorityResponse
    })?;

    Ok((StatusCode::CREATED, Json(descriptor)))
}

enum ReferenceServiceError {
    AuthorityUnavailable,
    AuthorityRejected,
    InvalidAuthorityResponse,
}

impl IntoResponse for ReferenceServiceError {
    fn into_response(self) -> Response {
        let code = match self {
            Self::AuthorityUnavailable | Self::InvalidAuthorityResponse => "authority_unavailable",
            Self::AuthorityRejected => "authority_rejected_request",
        };

        (StatusCode::BAD_GATEWAY, Json(ErrorResponse { error: code })).into_response()
    }
}

#[derive(Serialize)]
struct ErrorResponse {
    error: &'static str,
}
