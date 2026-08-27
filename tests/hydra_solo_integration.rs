use std::{
    error::Error,
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use axum::Router;
use bitcoin::{Address, Amount, Network, Transaction, consensus::deserialize, hex::FromHex as _};
use bwg_core::{
    authority::{
        self, AuthorityApplication, AuthorityPublicConfig, CLAIMANT_PROOF_HEADER, CLIENT_ID_HEADER,
        Config, DeploymentEnvironment, IssuanceProcessingOutcome, IssuanceWorkerId,
        ServiceCredential, SimulatedPoolAdapter,
    },
    challenge::{ActionPolicy, ChallengeId},
    lifecycle::WorkerClock,
    pool_offer::PoolSelection,
    progress::{
        AcceptedWorkEvent, AcceptedWorkEventId, AcceptedWorkEventInput, NetworkTargetOutcome,
        ReceiptTime, ShareFingerprint, WorkSessionId,
    },
    reference_service,
    stratum_v1::{
        AcceptedWorkDeliveryWorker, AcceptedWorkSink, AcceptedWorkSinkError, DeliveryOutcome,
        PostgresAcceptedWorkOutbox, PostgresStratumSessionRegistry, StratumCredentialIssuer,
        StratumLeaseContext, StratumTcpProxy, StratumUpstreamAuthorization, StratumV1Error,
    },
};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt as _, BufReader},
    net::{
        TcpListener, TcpStream,
        tcp::{OwnedReadHalf, OwnedWriteHalf},
    },
    time::Duration,
};

#[path = "support/postgres.rs"]
mod postgres_support;
use postgres_support::PostgresTestDatabase;
#[path = "support/stratum_hash.rs"]
mod stratum_hash_support;

#[path = "support/authority_keys.rs"]
mod authority_key_support;
use authority_key_support::authority_keys;

#[path = "support/claimant.rs"]
mod claimant_support;
use claimant_support::Claimant;

#[path = "hydra_solo_integration/protocol.rs"]
mod protocol;
use protocol::*;
#[path = "hydra_solo_integration/fixture.rs"]
mod fixture;
use fixture::*;
#[path = "hydra_solo_integration/journey.rs"]
mod journey;
use journey::{close_initial_worker_after_gate_outage, issue_gate_pass, run_initial_worker};
#[path = "hydra_solo_integration/block_submission.rs"]
mod block_submission;
use block_submission::{IndependentSubmissionInput, submit_network_block_after_reconnect};
#[path = "hydra_solo_integration/session_mismatch.rs"]
mod session_mismatch;
#[path = "hydra_solo_integration/task_guard.rs"]
mod task_guard;
use task_guard::{AbortTaskOnDrop, TaskCompletion};

#[tokio::test]
async fn postgres_container_recovers_after_the_outage_boundary() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;

    // Act
    database.pause().await?;
    database.resume().await?;
    let value = sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&sqlx::PgPool::connect(database.database_url()).await?)
        .await?;

    // Assert
    assert_eq!(value, 1);
    Ok(())
}

#[tokio::test]
#[ignore = "run through scripts/verify-hydra-solo-integration.sh"]
async fn standard_worker_crosses_proxy_and_pinned_hydra_with_direct_payout()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let mut fixture = arrange_integration().await?;

    // Act
    let initial_worker = run_initial_worker(&fixture).await?;
    let issued_pass_before = issue_gate_pass(&fixture).await?;
    let first_extranonce =
        close_initial_worker_after_gate_outage(&mut fixture, initial_worker).await?;
    let IntegrationFixture {
        database,
        hydra_address,
        outbox,
        sessions,
        adapter,
        credentials,
        upstream_authorization,
        challenge_id,
        claimant,
        ..
    } = fixture;
    submit_network_block_after_reconnect(IndependentSubmissionInput {
        outbox,
        sessions,
        adapter,
        database,
        upstream_authorization,
        hydra_address,
        credentials: &credentials,
        first_extranonce: &first_extranonce,
        challenge_id: &challenge_id,
        claimant: &claimant,
        issued_pass_before,
    })
    .await?;

    // Assert: each phase verifies its own stable integration seam.
    Ok(())
}

struct VardiffInput<'a> {
    username: &'a str,
    params: &'a [Value],
    observed: &'a [Value],
    extranonce1: &'a str,
    extranonce2: &'a str,
}

async fn exercise_vardiff(
    worker_lines: &mut tokio::io::Lines<BufReader<OwnedReadHalf>>,
    worker_write: &mut OwnedWriteHalf,
    proxy_task: &mut tokio::task::JoinHandle<Result<(), StratumV1Error>>,
    input: VardiffInput<'_>,
) -> Result<(), Box<dyn Error>> {
    let VardiffInput {
        username,
        params,
        observed,
        extranonce1,
        extranonce2,
    } = input;
    let job_id = params[0].as_str().ok_or("Hydra job ID must be a string")?;
    let ntime = params[7].as_str().ok_or("Hydra ntime must be a string")?;
    let initial_difficulty = observed
        .iter()
        .find(|value| value["method"] == "mining.set_difficulty")
        .map(|value| value["params"][0].clone())
        .ok_or("Hydra must assign an initial difficulty")?;
    let initial_target = assigned_target(&initial_difficulty)?;
    let mut accepted = Vec::new();
    let mut minimum_nonce = 0;
    for request_id in 3..=5 {
        let nonce = worked_nonce(
            params,
            extranonce1,
            extranonce2,
            initial_target,
            false,
            minimum_nonce,
        )?;
        write_line(
            worker_write,
            &format!(
                r#"{{"id":{request_id},"method":"mining.submit","params":["{}","{job_id}","{extranonce2}","{ntime}","{nonce}"]}}"#,
                username
            ),
        )
        .await?;
        let response = match next_matching(worker_lines, |value| value["id"] == request_id).await {
            Ok(value) => value,
            Err(error) => {
                return Err(format!(
                    "waiting for accepted share {request_id}: {error}; proxy result: {:?}",
                    proxy_task.await?
                )
                .into());
            }
        };
        accepted.push(response);
        minimum_nonce = u32::from_str_radix(&nonce, 16)? + 1;
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let adjusted_difficulty = next_matching(worker_lines, |value| {
        value["method"] == "mining.set_difficulty" && value["params"][0] != initial_difficulty
    })
    .await
    .map_err(|error| format!("waiting for adjusted difficulty: {error}"))?;
    let adjusted_notify = next_matching(worker_lines, |value| value["method"] == "mining.notify")
        .await
        .map_err(|error| format!("waiting for adjusted job: {error}"))?;
    let adjusted_params = adjusted_notify["params"]
        .as_array()
        .ok_or("adjusted Hydra notify params must be an array")?;
    let adjusted_job_id = adjusted_params[0]
        .as_str()
        .ok_or("adjusted Hydra job ID must be a string")?
        .to_owned();
    let adjusted_ntime = adjusted_params[7]
        .as_str()
        .ok_or("adjusted Hydra ntime must be a string")?
        .to_owned();
    let adjusted_nonce = worked_nonce(
        adjusted_params,
        extranonce1,
        extranonce2,
        assigned_target(&adjusted_difficulty["params"][0])?,
        false,
        0,
    )?;
    write_line(
        worker_write,
        &format!(
            r#"{{"id":6,"method":"mining.submit","params":["{}","{adjusted_job_id}","{extranonce2}","{adjusted_ntime}","{adjusted_nonce}"]}}"#,
            username
        ),
    )
    .await?;
    let adjusted_accepted = next_matching(worker_lines, |value| value["id"] == 6).await?;
    write_line(
        worker_write,
        &format!(
            r#"{{"id":7,"method":"mining.submit","params":["{}","{adjusted_job_id}","{extranonce2}","{adjusted_ntime}","{adjusted_nonce}"]}}"#,
            username
        ),
    )
    .await?;
    let rejected_duplicate = next_matching(worker_lines, |value| value["id"] == 7).await?;

    assert!(accepted.iter().all(|response| response["result"] == true));
    assert_eq!(adjusted_accepted["result"], true);
    assert_ne!(rejected_duplicate["result"], true);
    assert!(rejected_duplicate["error"].is_array());
    assert_eq!(initial_difficulty, serde_json::json!(0.0000000001));
    assert_ne!(adjusted_difficulty["params"][0], initial_difficulty);
    Ok(())
}
