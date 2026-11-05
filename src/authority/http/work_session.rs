//! Claimant Work Session routes (ADR-0106). The claimant proof binds the exact body.

use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, State},
    http::HeaderMap,
    routing::post,
};
use serde::{Deserialize, de::DeserializeOwned};

use super::{
    ApiError, AuthorityState, CancelChallengeRequest, PauseChallengeRequest, current_unix_seconds,
};
use crate::{
    authority::CLAIMANT_PROOF_HEADER,
    authority_application::{ClaimantWorkSessionRequest, WorkSessionOperation},
    challenge::ChallengeId,
    lifecycle::ChallengeLifecycle,
    work_lease_authorization::{ControlSessionBinding, WorkerLeaseGrant, WorkerLeaseRenewal},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StartWorkRequest {
    control_session_binding_sha256: String,
    #[serde(default, rename = "trusted_consent_receipt")]
    maybe_trusted_consent_receipt: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResumeWorkRequest {
    control_session_binding_sha256: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RenewWorkRequest {
    control_session_binding_sha256: String,
    lease_id: String,
}

/// Mounts the claimant routes under one challenge's Work Session.
pub(super) fn routes() -> Router<AuthorityState> {
    const PREFIX: &str = "/v0/challenges/{challenge_id}/work-session";
    Router::new()
        .route(&format!("{PREFIX}/start"), post(start_work))
        .route(&format!("{PREFIX}/resume"), post(resume_work))
        .route(&format!("{PREFIX}/renew"), post(renew_work))
        .route(&format!("{PREFIX}/pause"), post(pause_work))
        .route(&format!("{PREFIX}/cancel"), post(cancel_work))
}

async fn start_work(
    State(state): State<AuthorityState>,
    Path(challenge_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<WorkerLeaseGrant>, ApiError> {
    let challenge_id = verified_challenge(
        &state,
        challenge_id,
        WorkSessionOperation::Start,
        &headers,
        &body,
    )
    .await?;
    let request: StartWorkRequest = parse_body(&body)?;
    let control_session = control_session(request.control_session_binding_sha256)?;
    Ok(Json(
        state
            .application
            .claimant_start_work(
                &challenge_id,
                &control_session,
                request.maybe_trusted_consent_receipt.as_deref(),
            )
            .await?,
    ))
}

async fn resume_work(
    State(state): State<AuthorityState>,
    Path(challenge_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<WorkerLeaseGrant>, ApiError> {
    let challenge_id = verified_challenge(
        &state,
        challenge_id,
        WorkSessionOperation::Resume,
        &headers,
        &body,
    )
    .await?;
    let request: ResumeWorkRequest = parse_body(&body)?;
    let control_session = control_session(request.control_session_binding_sha256)?;
    Ok(Json(
        state
            .application
            .claimant_resume_work(&challenge_id, &control_session)
            .await?,
    ))
}

async fn renew_work(
    State(state): State<AuthorityState>,
    Path(challenge_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<WorkerLeaseRenewal>, ApiError> {
    let challenge_id = verified_challenge(
        &state,
        challenge_id,
        WorkSessionOperation::Renew,
        &headers,
        &body,
    )
    .await?;
    let request: RenewWorkRequest = parse_body(&body)?;
    let control_session = control_session(request.control_session_binding_sha256)?;
    Ok(Json(
        state
            .application
            .claimant_renew_work(&challenge_id, &control_session, request.lease_id)
            .await?,
    ))
}

async fn pause_work(
    State(state): State<AuthorityState>,
    Path(challenge_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<ChallengeLifecycle>, ApiError> {
    let challenge_id = verified_challenge(
        &state,
        challenge_id,
        WorkSessionOperation::Pause,
        &headers,
        &body,
    )
    .await?;
    let request: PauseChallengeRequest = parse_body(&body)?;
    Ok(Json(
        state
            .application
            .pause_challenge(&challenge_id, request.reason, current_unix_seconds()?)
            .await?,
    ))
}

async fn cancel_work(
    State(state): State<AuthorityState>,
    Path(challenge_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<ChallengeLifecycle>, ApiError> {
    let challenge_id = verified_challenge(
        &state,
        challenge_id,
        WorkSessionOperation::Cancel,
        &headers,
        &body,
    )
    .await?;
    let request: CancelChallengeRequest = parse_body(&body)?;
    if !request.confirm_progress_loss {
        return Err(ApiError::CancelConfirmationRequired);
    }
    Ok(Json(
        state
            .application
            .cancel_challenge(&challenge_id, current_unix_seconds()?)
            .await?,
    ))
}

async fn verified_challenge(
    state: &AuthorityState,
    challenge_id: String,
    operation: WorkSessionOperation,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<ChallengeId, ApiError> {
    let challenge_id = ChallengeId::try_from(challenge_id)?;
    let compact_proof = headers
        .get(CLAIMANT_PROOF_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or(ApiError::Unauthorized)?;
    state
        .application
        .verify_claimant_work_session_request(ClaimantWorkSessionRequest {
            challenge_id: &challenge_id,
            operation,
            compact_proof,
            body,
            now: current_unix_seconds()?,
        })
        .await?;
    Ok(challenge_id)
}

fn parse_body<T: DeserializeOwned>(body: &[u8]) -> Result<T, ApiError> {
    serde_json::from_slice(body).map_err(|_| ApiError::InvalidWorkSessionRequest)
}

fn control_session(value: String) -> Result<ControlSessionBinding, ApiError> {
    ControlSessionBinding::try_from(value).map_err(|_| ApiError::InvalidWorkSessionRequest)
}
