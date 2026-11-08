//! Rehearsal-only control routes on their own loopback listener, never on the origin.

use std::{
    error::Error,
    net::SocketAddr,
    sync::{Arc, atomic::Ordering},
};

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
};
use bwg_core::stratum_v1::PostgresAcceptedWorkOutbox;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use tokio::{sync::Mutex, task::JoinHandle};

use crate::{chain::RegtestChain, miner, synthetic};

#[derive(Clone)]
pub(crate) struct ControlState {
    pool: PgPool,
    outbox: PostgresAcceptedWorkOutbox,
    stats: Arc<miner::MinerStats>,
    miner: Arc<Mutex<Option<JoinHandle<()>>>>,
    chain: Arc<RegtestChain>,
}

impl ControlState {
    pub(crate) async fn new(
        adapter_database_url: &str,
        outbox: PostgresAcceptedWorkOutbox,
        chain: RegtestChain,
    ) -> Result<Self, Box<dyn Error>> {
        Ok(Self {
            pool: PgPoolOptions::new()
                .max_connections(2)
                .connect(adapter_database_url)
                .await?,
            outbox,
            stats: Arc::new(miner::MinerStats::default()),
            miner: Arc::new(Mutex::new(None)),
            chain: Arc::new(chain),
        })
    }
}

/// The Worker's Stratum credentials, as the fake serial device received them.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MinerStart {
    endpoint: String,
    username: String,
    password: String,
}

pub(crate) fn router(state: ControlState) -> Router {
    Router::new()
        .route("/miner", get(miner_stats))
        .route("/miner/start", post(start_miner))
        .route("/miner/stop", post(stop_miner))
        .route("/chain/block", post(mine_block))
        .route(
            "/challenges/{challenge_id}/synthetic-share",
            post(queue_synthetic_share),
        )
        .route(
            "/challenges/{challenge_id}/delivery",
            get(delivery_evidence),
        )
        .with_state(state)
}

async fn start_miner(
    State(state): State<ControlState>,
    Json(request): Json<MinerStart>,
) -> Result<StatusCode, (StatusCode, String)> {
    let address = stratum_address(&request.endpoint).ok_or((
        StatusCode::BAD_REQUEST,
        "invalid Stratum endpoint".to_owned(),
    ))?;
    let mut running = state.miner.lock().await;
    if let Some(previous) = running.take() {
        previous.abort();
    }
    let stats = state.stats.clone();
    *running = Some(tokio::spawn(async move {
        if let Err(error) = miner::run(address, request.username, request.password, stats).await {
            tracing::info!(%error, "rehearsal miner stopped");
        }
    }));
    Ok(StatusCode::NO_CONTENT)
}

async fn stop_miner(State(state): State<ControlState>) -> StatusCode {
    if let Some(running) = state.miner.lock().await.take() {
        running.abort();
    }
    StatusCode::NO_CONTENT
}

/// Mines one regtest block, so the pool sees a new Bitcoin tip mid-lease.
async fn mine_block(
    State(state): State<ControlState>,
) -> Result<Json<Value>, (StatusCode, String)> {
    state
        .chain
        .mine_block()
        .await
        .map(Json)
        .map_err(|error| (StatusCode::BAD_GATEWAY, error.to_string()))
}

async fn miner_stats(State(state): State<ControlState>) -> Json<Value> {
    let running = state
        .miner
        .lock()
        .await
        .as_ref()
        .is_some_and(|handle| !handle.is_finished());
    Json(json!({
        "running": running,
        "submitted": state.stats.submitted.load(Ordering::Relaxed),
        "accepted": state.stats.accepted.load(Ordering::Relaxed),
        "rejected": state.stats.rejected.load(Ordering::Relaxed),
        "reconnects": state.stats.reconnects.load(Ordering::Relaxed),
        "staleAnswered": state.stats.stale_answered.load(Ordering::Relaxed),
        "difficultyRefused": state.stats.difficulty_refused.load(Ordering::Relaxed),
    }))
}

async fn queue_synthetic_share(
    State(state): State<ControlState>,
    Path(challenge_id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    match synthetic::queue(&state.pool, &state.outbox, &challenge_id).await {
        Ok(true) => Ok(StatusCode::NO_CONTENT),
        Ok(false) => Err((
            StatusCode::CONFLICT,
            "no acknowledged real share yet".to_owned(),
        )),
        Err(error) => Err((StatusCode::INTERNAL_SERVER_ERROR, error.to_string())),
    }
}

async fn delivery_evidence(
    State(state): State<ControlState>,
    Path(challenge_id): Path<String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    synthetic::delivery_evidence(&state.pool, &challenge_id)
        .await
        .map(Json)
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))
}

fn stratum_address(endpoint: &str) -> Option<SocketAddr> {
    endpoint
        .strip_prefix("stratum+tcp://")?
        .trim_end_matches('/')
        .parse()
        .ok()
}
