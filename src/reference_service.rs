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
    crypto_profile::{AuthorityJwkWire, AuthorityKeySet},
    service_auth::{ServiceClientId, ServiceSecret},
    web_url::{AuthorityEndpointUrl, HttpsUrl},
};

#[cfg(test)]
mod tests;

/// Authority identity and keys trusted by operator configuration, never discovery alone.
#[derive(Clone)]
pub struct TrustedAuthority {
    issuer: HttpsUrl,
    keys: AuthorityKeySet,
}

impl TrustedAuthority {
    /// Parses an explicitly configured issuer and trusted verification-key set.
    pub fn new(
        issuer: impl Into<String>,
        key_wires: Vec<AuthorityJwkWire>,
    ) -> Result<Self, ReferenceConfigError> {
        let issuer = HttpsUrl::try_from(issuer.into())
            .map_err(|_| ReferenceConfigError::InvalidTrustedIssuer)?;
        let keys = AuthorityKeySet::try_from(key_wires)
            .map_err(|_| ReferenceConfigError::InvalidTrustedKeys)?;
        Ok(Self { issuer, keys })
    }

    /// Returns the explicitly trusted issuer.
    pub fn issuer(&self) -> &str {
        self.issuer.as_str()
    }

    /// Returns the explicitly trusted key identifiers.
    pub fn key_ids(&self) -> Vec<&str> {
        self.keys.key_ids()
    }
}

/// Server-only configuration for the reference account-creation integration.
#[derive(Clone)]
pub struct Config {
    authority_base_url: AuthorityEndpointUrl,
    service_client_id: ServiceClientId,
    service_credential: ServiceSecret,
    trusted_authority: TrustedAuthority,
}

impl Config {
    /// Configures backend authentication and an independently trusted Authority issuer.
    pub fn new(
        authority_base_url: impl Into<String>,
        service_client_id: impl Into<String>,
        service_credential: impl Into<String>,
        trusted_authority: TrustedAuthority,
    ) -> Result<Self, ReferenceConfigError> {
        Ok(Self {
            authority_base_url: AuthorityEndpointUrl::try_from(authority_base_url.into())
                .map_err(|_| ReferenceConfigError::InvalidAuthorityEndpoint)?,
            service_client_id: ServiceClientId::try_from(service_client_id.into())
                .map_err(|_| ReferenceConfigError::InvalidClientId)?,
            service_credential: ServiceSecret::try_from(service_credential.into())
                .map_err(|_| ReferenceConfigError::InvalidServiceSecret)?,
            trusted_authority,
        })
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
        action_policy: ActionPolicy::ACCOUNT_CREATION_STANDARD_V1.to_owned(),
        action_reference: format!("action_{}", Uuid::new_v4().simple()),
        claimant_key: request.claimant_key,
        maybe_overrides: None,
    };
    let response = state
        .http_client
        .post(format!(
            "{}/v0/challenges",
            state.config.authority_base_url.as_str()
        ))
        .header(CLIENT_ID_HEADER, state.config.service_client_id.as_str())
        .bearer_auth(state.config.service_credential.expose_secret())
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
    #[error("Authority endpoint must use HTTPS or loopback HTTP")]
    InvalidAuthorityEndpoint,
    #[error("service client identifier is invalid")]
    InvalidClientId,
    #[error("service credential is not a high-entropy base64url token")]
    InvalidServiceSecret,
    #[error("trusted Authority issuer must use HTTPS")]
    InvalidTrustedIssuer,
    #[error("trusted Authority keys must be valid, non-empty, and unique")]
    InvalidTrustedKeys,
}
