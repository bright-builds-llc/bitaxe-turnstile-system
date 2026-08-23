use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::{
    authority::{CLIENT_ID_HEADER, CreateChallengeRequest},
    challenge::{ActionPolicy, WorkChallengeDescriptor},
    crypto_profile::{AuthorityJwkWire, AuthorityKeySet},
    redemption::{RedemptionRecord, RedemptionRequest},
    service_auth::{ServiceClientId, ServiceSecret},
    web_url::{AuthorityEndpointUrl, HttpsUrl},
};

pub use crate::reference_application::ReferenceApplication;
pub use crate::reference_application::{
    ActionProcessingOutcome, ActionWorkerId, ReferenceApplicationError,
};

/// Claimant-signed proof header required for read-only outcome lookup.
pub const CLAIMANT_PROOF_HEADER: &str = "bwg-claimant-proof";

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

    pub(crate) fn key_wires(&self) -> Vec<AuthorityJwkWire> {
        self.keys.to_wires()
    }
}

/// Server-only configuration for the reference account-creation integration.
#[derive(Clone)]
pub struct Config {
    authority_base_url: AuthorityEndpointUrl,
    service_client_id: ServiceClientId,
    service_credential: ServiceSecret,
    trusted_authority: TrustedAuthority,
    relying_service_audience: HttpsUrl,
    redemption_url: AuthorityEndpointUrl,
    maybe_account_creation_executor: Option<AccountCreationExecutor>,
    outcome_lookup_window_seconds: u64,
}

impl Config {
    /// Configures backend authentication and an independently trusted Authority issuer.
    pub fn new(
        authority_base_url: impl Into<String>,
        service_client_id: impl Into<String>,
        service_credential: impl Into<String>,
        relying_service_audience: impl Into<String>,
        redemption_url: impl Into<String>,
        trusted_authority: TrustedAuthority,
    ) -> Result<Self, ReferenceConfigError> {
        Ok(Self {
            authority_base_url: AuthorityEndpointUrl::try_from(authority_base_url.into())
                .map_err(|_| ReferenceConfigError::InvalidAuthorityEndpoint)?,
            service_client_id: ServiceClientId::try_from(service_client_id.into())
                .map_err(|_| ReferenceConfigError::InvalidClientId)?,
            service_credential: ServiceSecret::try_from(service_credential.into())
                .map_err(|_| ReferenceConfigError::InvalidServiceSecret)?,
            relying_service_audience: HttpsUrl::try_from(relying_service_audience.into())
                .map_err(|_| ReferenceConfigError::InvalidRelyingServiceAudience)?,
            redemption_url: AuthorityEndpointUrl::try_from(redemption_url.into())
                .map_err(|_| ReferenceConfigError::InvalidRedemptionUrl)?,
            trusted_authority,
            maybe_account_creation_executor: None,
            outcome_lookup_window_seconds: 24 * 60 * 60,
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

    pub(crate) fn trusted_authority(&self) -> &TrustedAuthority {
        &self.trusted_authority
    }

    pub(crate) fn relying_service_audience(&self) -> &str {
        self.relying_service_audience.as_str()
    }

    pub(crate) fn redemption_url(&self) -> &str {
        self.redemption_url.as_str()
    }

    /// Enables the reference account-creation executor for runnable deployments.
    pub fn with_account_creation_executor(mut self) -> Self {
        self.maybe_account_creation_executor = Some(AccountCreationExecutor::Succeed);
        self
    }

    /// Configures a deterministic failing executor for integration and failure-policy profiles.
    pub fn with_failing_account_creation_executor(
        mut self,
        error_class: String,
    ) -> Result<Self, ReferenceConfigError> {
        if error_class.is_empty() {
            return Err(ReferenceConfigError::InvalidExecutionErrorClass);
        }
        self.maybe_account_creation_executor = Some(AccountCreationExecutor::Fail(error_class));
        Ok(self)
    }

    pub(crate) fn maybe_account_creation_executor(&self) -> Option<&AccountCreationExecutor> {
        self.maybe_account_creation_executor.as_ref()
    }

    pub(crate) fn outcome_lookup_url(&self, action_reference: &str) -> String {
        let base = self
            .redemption_url
            .as_str()
            .strip_suffix("/redeem")
            .unwrap_or(self.redemption_url.as_str());
        format!("{base}/outcomes/{action_reference}")
    }

    /// Overrides the claimant-facing Outcome Lookup retention window.
    pub fn with_outcome_lookup_window_seconds(
        mut self,
        window_seconds: u64,
    ) -> Result<Self, ReferenceConfigError> {
        if window_seconds == 0 {
            return Err(ReferenceConfigError::InvalidOutcomeLookupWindow);
        }
        self.outcome_lookup_window_seconds = window_seconds;
        Ok(self)
    }

    pub(crate) fn outcome_lookup_window_seconds(&self) -> u64 {
        self.outcome_lookup_window_seconds
    }
}

#[derive(Clone)]
struct ReferenceServiceState {
    application: ReferenceApplication,
    http_client: reqwest::Client,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BrowserChallengeRequest {
    claimant_key: String,
}

/// Builds the browser-facing reference account-creation interface.
pub fn router(application: ReferenceApplication) -> Router {
    Router::new()
        .route(
            "/account-creation/challenge",
            post(create_account_challenge),
        )
        .route("/account-creation/redeem", post(redeem_account_creation))
        .route(
            "/account-creation/outcomes/{action_reference}",
            get(lookup_account_creation_outcome),
        )
        .with_state(ReferenceServiceState {
            application,
            http_client: reqwest::Client::new(),
        })
}

async fn lookup_account_creation_outcome(
    State(state): State<ReferenceServiceState>,
    Path(action_reference): Path<String>,
    headers: HeaderMap,
) -> Result<Json<RedemptionRecord>, ReferenceServiceError> {
    let compact_proof = headers
        .get(CLAIMANT_PROOF_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or(ReferenceServiceError::InvalidClaimantProof)?;
    let now = std::time::SystemTime::UNIX_EPOCH
        .elapsed()
        .map_err(|_| ReferenceServiceError::InternalTime)?
        .as_secs();
    Ok(Json(
        state
            .application
            .outcome(&action_reference, compact_proof, now)
            .await?,
    ))
}

async fn redeem_account_creation(
    State(state): State<ReferenceServiceState>,
    Json(request): Json<RedemptionRequest>,
) -> Result<Json<RedemptionRecord>, ReferenceServiceError> {
    let now = std::time::SystemTime::UNIX_EPOCH
        .elapsed()
        .map_err(|_| ReferenceServiceError::InternalTime)?
        .as_secs();
    Ok(Json(state.application.redeem(request, now).await?))
}

async fn create_account_challenge(
    State(state): State<ReferenceServiceState>,
    Json(request): Json<BrowserChallengeRequest>,
) -> Result<(StatusCode, Json<WorkChallengeDescriptor>), ReferenceServiceError> {
    let action_reference = format!("action_{}", Uuid::new_v4().simple());
    let now = std::time::SystemTime::UNIX_EPOCH
        .elapsed()
        .map_err(|_| ReferenceServiceError::InternalTime)?
        .as_secs();
    state
        .application
        .insert_protected_action(&action_reference, &request.claimant_key, now)
        .await?;
    let authority_request = CreateChallengeRequest {
        action_policy: ActionPolicy::ACCOUNT_CREATION_STANDARD_V1.to_owned(),
        action_reference,
        claimant_key: request.claimant_key,
        maybe_overrides: None,
    };
    let response = state
        .http_client
        .post(format!(
            "{}/v0/challenges",
            state.application.config.authority_base_url.as_str()
        ))
        .header(
            CLIENT_ID_HEADER,
            state.application.config.service_client_id.as_str(),
        )
        .bearer_auth(state.application.config.service_credential.expose_secret())
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
    InvalidApplication(ReferenceApplicationError),
    InternalTime,
    InvalidClaimantProof,
}

impl From<ReferenceApplicationError> for ReferenceServiceError {
    fn from(error: ReferenceApplicationError) -> Self {
        Self::InvalidApplication(error)
    }
}

impl IntoResponse for ReferenceServiceError {
    fn into_response(self) -> Response {
        let (status, code) = match self {
            Self::AuthorityUnavailable | Self::InvalidAuthorityResponse => {
                (StatusCode::BAD_GATEWAY, "authority_unavailable")
            }
            Self::AuthorityRejected => (StatusCode::BAD_GATEWAY, "authority_rejected_request"),
            Self::InvalidClaimantProof => (StatusCode::UNAUTHORIZED, "invalid_claimant_proof"),
            Self::InvalidApplication(ReferenceApplicationError::OutcomeUnavailable) => {
                (StatusCode::NOT_FOUND, "outcome_unavailable")
            }
            Self::InvalidApplication(
                ReferenceApplicationError::InvalidOutcomeProof
                | ReferenceApplicationError::WrongOutcomeProofRequest
                | ReferenceApplicationError::StaleOutcomeProof
                | ReferenceApplicationError::ReplayedOutcomeProof,
            ) => (StatusCode::UNAUTHORIZED, "invalid_claimant_proof"),
            Self::InvalidApplication(error) => {
                tracing::warn!(%error, "Redemption request rejected");
                (StatusCode::UNAUTHORIZED, "invalid_redemption")
            }
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
pub enum ReferenceConfigError {
    #[error("Authority endpoint must use HTTPS or loopback HTTP")]
    InvalidAuthorityEndpoint,
    #[error("service client identifier is invalid")]
    InvalidClientId,
    #[error("service credential is not a high-entropy base64url token")]
    InvalidServiceSecret,
    #[error("Relying Service audience must use HTTPS")]
    InvalidRelyingServiceAudience,
    #[error("Redemption URL must use HTTPS or loopback HTTP")]
    InvalidRedemptionUrl,
    #[error("trusted Authority issuer must use HTTPS")]
    InvalidTrustedIssuer,
    #[error("trusted Authority keys must be valid, non-empty, and unique")]
    InvalidTrustedKeys,
    #[error("Outcome Lookup window must be positive")]
    InvalidOutcomeLookupWindow,
    #[error("execution error class must be non-empty")]
    InvalidExecutionErrorClass,
}

#[derive(Clone)]
pub(crate) enum AccountCreationExecutor {
    Succeed,
    Fail(String),
}
