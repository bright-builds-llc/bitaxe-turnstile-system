//! A regtest CPU Stratum V1 miner behind a loopback HTTP control, standing in for a claimant's
//! standard Worker in the self-host proof (bwg-core Ticket 24). It is the rehearsal's miner, so it
//! mines as a Worker configured by hand would: from the endpoint, username and password the page
//! shows. Test support only, never part of `bwg-core`.
//!
//! Environment: `BWG_MINER_CONTROL_ADDRESS` (a loopback `HOST:PORT`; port 0 picks one). It prints
//! the control's port as its first line, then serves `GET /miner`, `POST /miner/start` and
//! `POST /miner/stop`.

#[path = "production-path-rehearsal/miner.rs"]
mod miner;
#[path = "../tests/support/stratum_hash.rs"]
mod stratum_hash_support;

use std::{error::Error, net::SocketAddr, sync::Arc, sync::atomic::Ordering};

use axum::{Json, Router, extract::State, http::StatusCode, routing::get, routing::post};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{sync::Mutex, task::JoinHandle};

#[derive(Clone)]
struct MinerState {
    running: Arc<Mutex<Option<JoinHandle<()>>>>,
    stats: Arc<miner::MinerStats>,
}

#[derive(Deserialize)]
struct MinerStart {
    endpoint: String,
    username: String,
    password: String,
}

fn stratum_address(endpoint: &str) -> Option<SocketAddr> {
    endpoint
        .strip_prefix("stratum+tcp://")?
        .trim_end_matches('/')
        .parse()
        .ok()
}

async fn start(
    State(state): State<MinerState>,
    Json(request): Json<MinerStart>,
) -> Result<StatusCode, (StatusCode, String)> {
    let address = stratum_address(&request.endpoint).ok_or((
        StatusCode::BAD_REQUEST,
        "invalid Stratum endpoint".to_owned(),
    ))?;
    let mut running = state.running.lock().await;
    if let Some(previous) = running.take() {
        previous.abort();
    }
    let stats = state.stats.clone();
    *running = Some(tokio::spawn(async move {
        if let Err(error) = miner::run(address, request.username, request.password, stats).await {
            tracing::info!(%error, "CPU miner stopped");
        }
    }));
    Ok(StatusCode::NO_CONTENT)
}

async fn stop(State(state): State<MinerState>) -> StatusCode {
    if let Some(running) = state.running.lock().await.take() {
        running.abort();
    }
    StatusCode::NO_CONTENT
}

async fn stats(State(state): State<MinerState>) -> Json<Value> {
    let running = state
        .running
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

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .init();
    let address: SocketAddr = std::env::var("BWG_MINER_CONTROL_ADDRESS")?.parse()?;
    if !address.ip().is_loopback() {
        return Err("BWG_MINER_CONTROL_ADDRESS must be a loopback address".into());
    }
    let state = MinerState {
        running: Arc::new(Mutex::new(None)),
        stats: Arc::new(miner::MinerStats::default()),
    };
    let router = Router::new()
        .route("/miner", get(stats))
        .route("/miner/start", post(start))
        .route("/miner/stop", post(stop))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(address).await?;
    println!("{}", listener.local_addr()?.port());
    axum::serve(listener, router).await?;
    Ok(())
}
