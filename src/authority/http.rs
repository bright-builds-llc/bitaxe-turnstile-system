use std::time::SystemTime;

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header::RETRY_AFTER},
    response::{
        IntoResponse, Response, Sse,
        sse::{Event, KeepAlive},
    },
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use tokio_stream::{
    Stream, StreamExt as _,
    wrappers::{BroadcastStream, errors::BroadcastStreamRecvError},
};
use uuid::Uuid;

use super::CLAIMANT_PROOF_HEADER;
use crate::{
    authority_application::{AuthorityApplication, AuthorityApplicationError, IssuanceLookup},
    authority_descriptor::{AuthorityDescriptor, JwksDocument},
    challenge::{
        ActionPolicy, ActionReference, ChallengeError, ChallengeId, ClaimantKey,
        IssueChallengeCommand, WorkChallengeDescriptor, WorkRequirementOverride, issue_challenge,
    },
    lifecycle::{ChallengeLifecycle, PauseReason},
    progress::ProgressError,
    trusted_consent::{TrustedConsentBeginRequest, TrustedConsentCeremonyId, TrustedConsentError},
};

#[derive(Clone)]
struct AuthorityState {
    application: AuthorityApplication,
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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PauseChallengeRequest {
    reason: PauseReason,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CancelChallengeRequest {
    confirm_progress_loss: bool,
}

/// Builds the versioned Gate Authority HTTP interface.
pub fn router(application: AuthorityApplication) -> Router {
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
        .route(
            "/v0/challenges/{challenge_id}/gate-pass",
            get(challenge_gate_pass),
        )
        .route(
            "/v0/challenges/{challenge_id}/lifecycle",
            get(challenge_lifecycle),
        )
        .route("/v0/challenges/{challenge_id}/pause", post(pause_challenge))
        .route(
            "/v0/challenges/{challenge_id}/cancel",
            post(cancel_challenge),
        )
        .route(
            "/v0/challenges/{challenge_id}/trusted-consent",
            post(begin_trusted_consent),
        )
        .route(
            "/v0/challenges/{challenge_id}/trusted-consent/{ceremony_id}",
            post(finish_trusted_consent),
        )
        .with_state(AuthorityState { application })
}

async fn begin_trusted_consent(
    State(state): State<AuthorityState>,
    Path(challenge_id): Path<String>,
    Json(request): Json<TrustedConsentBeginRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let challenge_id = ChallengeId::try_from(challenge_id)?;
    Ok(Json(
        state
            .application
            .begin_trusted_consent(&challenge_id, request, current_unix_seconds()?)
            .await?,
    ))
}

async fn finish_trusted_consent(
    State(state): State<AuthorityState>,
    Path((challenge_id, ceremony_id)): Path<(String, String)>,
    Json(credential): Json<serde_json::Value>,
) -> Result<impl IntoResponse, ApiError> {
    let challenge_id = ChallengeId::try_from(challenge_id)?;
    let ceremony_id =
        TrustedConsentCeremonyId::try_from(ceremony_id).map_err(AuthorityApplicationError::from)?;
    Ok(Json(
        state
            .application
            .finish_trusted_consent(
                &challenge_id,
                &ceremony_id,
                credential,
                current_unix_seconds()?,
            )
            .await?,
    ))
}

async fn challenge_lifecycle(
    State(state): State<AuthorityState>,
    Path(challenge_id): Path<String>,
) -> Result<Json<ChallengeLifecycle>, ApiError> {
    let challenge_id = ChallengeId::try_from(challenge_id)?;
    Ok(Json(
        state
            .application
            .challenge_lifecycle(&challenge_id, current_unix_seconds()?)
            .await?,
    ))
}

async fn pause_challenge(
    State(state): State<AuthorityState>,
    Path(challenge_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<PauseChallengeRequest>,
) -> Result<Json<ChallengeLifecycle>, ApiError> {
    let credential = state.application.config.authenticate(&headers)?;
    let challenge_id = ChallengeId::try_from(challenge_id)?;
    state
        .application
        .ensure_challenge_controller(&challenge_id, credential.relying_service_audience.as_str())
        .await?;
    Ok(Json(
        state
            .application
            .pause_challenge(&challenge_id, request.reason, current_unix_seconds()?)
            .await?,
    ))
}

async fn cancel_challenge(
    State(state): State<AuthorityState>,
    Path(challenge_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<CancelChallengeRequest>,
) -> Result<Json<ChallengeLifecycle>, ApiError> {
    let credential = state.application.config.authenticate(&headers)?;
    if !request.confirm_progress_loss {
        return Err(ApiError::CancelConfirmationRequired);
    }
    let challenge_id = ChallengeId::try_from(challenge_id)?;
    state
        .application
        .ensure_challenge_controller(&challenge_id, credential.relying_service_audience.as_str())
        .await?;
    Ok(Json(
        state
            .application
            .cancel_challenge(&challenge_id, current_unix_seconds()?)
            .await?,
    ))
}

fn current_unix_seconds() -> Result<u64, ApiError> {
    SystemTime::UNIX_EPOCH
        .elapsed()
        .map_err(|_| ApiError::InternalTime)
        .map(|duration| duration.as_secs())
}

async fn authority_descriptor(State(state): State<AuthorityState>) -> Json<AuthorityDescriptor> {
    Json(state.application.config.descriptor.clone())
}

async fn authority_jwks(State(state): State<AuthorityState>) -> Json<JwksDocument> {
    Json(state.application.config.jwks.clone())
}

async fn challenge_progress(
    State(state): State<AuthorityState>,
    Path(challenge_id): Path<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, axum::Error>>>, ApiError> {
    let challenge_id = ChallengeId::try_from(challenge_id)?;
    let (progress_snapshot, progress_receiver) =
        state.application.subscribe_progress(&challenge_id).await?;
    let (lifecycle_snapshot, lifecycle_receiver) = state
        .application
        .subscribe_lifecycle(&challenge_id, current_unix_seconds()?)
        .await?;
    let initial = tokio_stream::iter([
        Event::default()
            .event("verified_progress")
            .json_data(progress_snapshot),
        Event::default()
            .event("challenge_lifecycle")
            .json_data(lifecycle_snapshot),
    ]);
    let progress_live = BroadcastStream::new(progress_receiver).filter_map(|result| match result {
        Ok(update) => Some(
            Event::default()
                .event("verified_progress")
                .json_data(update),
        ),
        Err(BroadcastStreamRecvError::Lagged(skipped)) => Some(Ok(Event::default()
            .event("resync_required")
            .data(format!("skipped {skipped} progress updates")))),
    });
    let lifecycle_live =
        BroadcastStream::new(lifecycle_receiver).filter_map(|result| match result {
            Ok(update) => Some(
                Event::default()
                    .event("challenge_lifecycle")
                    .json_data(update),
            ),
            Err(BroadcastStreamRecvError::Lagged(skipped)) => Some(Ok(Event::default()
                .event("resync_required")
                .data(format!("skipped {skipped} lifecycle updates")))),
        });
    Ok(Sse::new(initial.chain(progress_live.merge(lifecycle_live)))
        .keep_alive(KeepAlive::default()))
}

async fn challenge_gate_pass(
    State(state): State<AuthorityState>,
    Path(challenge_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<IssuanceLookup>, ApiError> {
    let challenge_id = ChallengeId::try_from(challenge_id)?;
    let compact_proof = headers
        .get(CLAIMANT_PROOF_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or(ApiError::Unauthorized)?;
    Ok(Json(
        state
            .application
            .issuance(&challenge_id, compact_proof, current_unix_seconds()?)
            .await?,
    ))
}

async fn create_challenge(
    State(state): State<AuthorityState>,
    headers: HeaderMap,
    Json(request): Json<CreateChallengeRequest>,
) -> Result<(StatusCode, Json<WorkChallengeDescriptor>), ApiError> {
    let credential = state.application.config.authenticate(&headers)?;
    let action_policy = ActionPolicy::parse(&request.action_policy)?;
    if !credential.permits(action_policy) {
        return Err(ApiError::PolicyNotPermitted);
    }
    let challenge_id = format!("challenge_{}", Uuid::new_v4().simple());
    let command = IssueChallengeCommand {
        action_policy,
        action_reference: ActionReference::try_from(request.action_reference)?,
        claimant_key: ClaimantKey::try_from(request.claimant_key)?,
        relying_service_audience: credential.relying_service_audience.clone(),
        allowed_origins: credential.allowed_origins.clone(),
        pool_offers: state
            .application
            .config
            .signed_pool_offers(&challenge_id, action_policy)
            .map_err(AuthorityApplicationError::from)?,
        maybe_work_requirement_override: request
            .maybe_overrides
            .map(|overrides| WorkRequirementOverride::expected_hashes(overrides.expected_hashes))
            .transpose()?,
    };
    let descriptor = issue_challenge(command, challenge_id, current_unix_seconds()?)?;
    state.application.insert_challenge(&descriptor).await?;
    Ok((StatusCode::CREATED, Json(descriptor)))
}

pub(super) enum ApiError {
    Unauthorized,
    TooManyAuthenticationAttempts,
    PolicyNotPermitted,
    CancelConfirmationRequired,
    InvalidChallenge(ChallengeError),
    InternalTime,
    InternalState,
    InvalidProgress(ProgressError),
    InvalidApplication(AuthorityApplicationError),
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

impl From<AuthorityApplicationError> for ApiError {
    fn from(error: AuthorityApplicationError) -> Self {
        Self::InvalidApplication(error)
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
            Self::CancelConfirmationRequired => {
                (StatusCode::BAD_REQUEST, "cancel_confirmation_required")
            }
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
            Self::InvalidApplication(AuthorityApplicationError::UnknownChallenge) => {
                (StatusCode::NOT_FOUND, "unknown_challenge")
            }
            Self::InvalidApplication(AuthorityApplicationError::IssuanceRetired) => {
                (StatusCode::GONE, "issuance_retired")
            }
            Self::InvalidApplication(AuthorityApplicationError::TrustedConsent(
                TrustedConsentError::UnknownCeremony,
            )) => (StatusCode::NOT_FOUND, "unknown_trusted_consent_ceremony"),
            Self::InvalidApplication(AuthorityApplicationError::TrustedConsent(
                TrustedConsentError::CeremonyExpired,
            )) => (StatusCode::GONE, "trusted_consent_expired"),
            Self::InvalidApplication(AuthorityApplicationError::TrustedConsent(
                TrustedConsentError::CeremonyFailed,
            )) => (StatusCode::GONE, "trusted_consent_failed"),
            Self::InvalidApplication(AuthorityApplicationError::TrustedConsent(
                TrustedConsentError::CeremonyAlreadyTerminal
                | TrustedConsentError::CeremonyInProgress
                | TrustedConsentError::LostVerificationLease,
            )) => (StatusCode::CONFLICT, "trusted_consent_already_terminal"),
            Self::InvalidApplication(AuthorityApplicationError::TrustedConsent(
                TrustedConsentError::WebauthnUnavailable
                | TrustedConsentError::ReceiptUnavailable
                | TrustedConsentError::InvalidWebauthnConfig
                | TrustedConsentError::MissingAttestationTrust
                | TrustedConsentError::InvalidAttestationTrust,
            )) => (
                StatusCode::SERVICE_UNAVAILABLE,
                "trusted_consent_unavailable",
            ),
            Self::InvalidApplication(AuthorityApplicationError::TrustedConsent(
                TrustedConsentError::InvalidWebauthnState,
            )) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "trusted_consent_state_invalid",
            ),
            Self::InvalidApplication(AuthorityApplicationError::TrustedConsent(_)) => {
                (StatusCode::BAD_REQUEST, "invalid_trusted_consent")
            }
            Self::InvalidApplication(AuthorityApplicationError::PoolOffer(
                crate::pool_offer::PoolOfferError::SigningUnavailable,
            )) => (
                StatusCode::SERVICE_UNAVAILABLE,
                "pool_offer_signing_unavailable",
            ),
            Self::InvalidApplication(AuthorityApplicationError::ChallengeControlNotPermitted) => {
                (StatusCode::FORBIDDEN, "challenge_control_not_permitted")
            }
            Self::InvalidApplication(
                AuthorityApplicationError::ForbiddenLifecycleTransition
                | AuthorityApplicationError::WrongWorkLease
                | AuthorityApplicationError::WorkerContinuityLost
                | AuthorityApplicationError::WorkLeaseExpired,
            ) => (StatusCode::CONFLICT, "lifecycle_transition_forbidden"),
            Self::InvalidApplication(
                AuthorityApplicationError::InvalidClaimantProof
                | AuthorityApplicationError::WrongIssuanceProofRequest
                | AuthorityApplicationError::StaleIssuanceProof
                | AuthorityApplicationError::WrongClaimantKey
                | AuthorityApplicationError::ReplayedIssuanceProof,
            ) => (StatusCode::UNAUTHORIZED, "invalid_claimant_proof"),
            Self::InvalidApplication(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "authority_persistence_failed",
            ),
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
