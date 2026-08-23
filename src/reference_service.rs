use std::{collections::HashSet, sync::Arc};

use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::{
    authority::{CLIENT_ID_HEADER, CreateChallengeRequest},
    challenge::{ActionPolicy, WorkChallengeDescriptor},
    crypto_profile::{AuthorityJwk, AuthorityJwkWire},
};

/// Authority identity and keys trusted by operator configuration, never discovery alone.
#[derive(Clone)]
pub struct TrustedAuthority {
    issuer: Arc<str>,
    keys: Arc<[AuthorityJwk]>,
}

impl TrustedAuthority {
    /// Parses an explicitly configured issuer and trusted verification-key set.
    pub fn new(
        issuer: impl Into<Arc<str>>,
        key_wires: Vec<AuthorityJwkWire>,
    ) -> Result<Self, ReferenceConfigError> {
        let issuer = issuer.into();
        if !issuer.starts_with("https://") {
            return Err(ReferenceConfigError::InvalidTrustedIssuer);
        }
        let keys = key_wires
            .into_iter()
            .map(AuthorityJwk::try_from)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| ReferenceConfigError::InvalidTrustedKeys)?;
        let unique_ids = keys.iter().map(AuthorityJwk::kid).collect::<HashSet<_>>();
        if keys.is_empty() || unique_ids.len() != keys.len() {
            return Err(ReferenceConfigError::InvalidTrustedKeys);
        }
        Ok(Self {
            issuer,
            keys: keys.into(),
        })
    }

    /// Returns the explicitly trusted issuer.
    pub fn issuer(&self) -> &str {
        &self.issuer
    }

    /// Returns the explicitly trusted key identifiers.
    pub fn key_ids(&self) -> Vec<&str> {
        self.keys.iter().map(AuthorityJwk::kid).collect()
    }
}

/// Server-only configuration for the reference account-creation integration.
#[derive(Clone)]
pub struct Config {
    authority_base_url: Arc<str>,
    service_client_id: Arc<str>,
    service_credential: Arc<str>,
    trusted_authority: TrustedAuthority,
}

impl Config {
    /// Configures backend authentication and an independently trusted Authority issuer.
    pub fn new(
        authority_base_url: impl Into<Arc<str>>,
        service_client_id: impl Into<Arc<str>>,
        service_credential: impl Into<Arc<str>>,
        trusted_authority: TrustedAuthority,
    ) -> Self {
        Self {
            authority_base_url: authority_base_url.into(),
            service_client_id: service_client_id.into(),
            service_credential: service_credential.into(),
            trusted_authority,
        }
    }

    /// Returns the issuer trusted by operator configuration, not discovery.
    pub fn trusted_authority_issuer(&self) -> &str {
        self.trusted_authority.issuer()
    }

    /// Returns the explicitly configured trusted Authority key identifiers.
    pub fn trusted_authority_key_ids(&self) -> Vec<&str> {
        self.trusted_authority.key_ids()
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
        maybe_overrides: None,
    };
    let response = state
        .http_client
        .post(format!(
            "{}/v0/challenges",
            state.config.authority_base_url.trim_end_matches('/')
        ))
        .header(CLIENT_ID_HEADER, state.config.service_client_id.as_ref())
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

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ReferenceConfigError {
    #[error("trusted Authority issuer must use HTTPS")]
    InvalidTrustedIssuer,
    #[error("trusted Authority keys must be valid, non-empty, and unique")]
    InvalidTrustedKeys,
}
