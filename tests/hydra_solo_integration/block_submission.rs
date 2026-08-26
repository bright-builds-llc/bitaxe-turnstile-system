use super::*;

pub(super) struct IndependentSubmissionInput<'a> {
    pub(super) outbox: PostgresAcceptedWorkOutbox,
    pub(super) sessions: PostgresStratumSessionRegistry,
    pub(super) database: PostgresTestDatabase,
    pub(super) upstream_authorization: StratumUpstreamAuthorization,
    pub(super) hydra_address: SocketAddr,
    pub(super) credentials: &'a bwg_core::stratum_v1::StratumSessionCredentials,
    pub(super) first_extranonce: &'a str,
    pub(super) challenge_id: &'a ChallengeId,
    pub(super) claimant: &'a Claimant,
    pub(super) issued_pass_before: IssuedPassSnapshot,
}

pub(super) async fn submit_network_block_after_reconnect(
    input: IndependentSubmissionInput<'_>,
) -> Result<(), Box<dyn Error>> {
    let IndependentSubmissionInput {
        outbox,
        sessions,
        database,
        upstream_authorization,
        hydra_address,
        credentials,
        first_extranonce,
        challenge_id,
        claimant,
        issued_pass_before,
    } = input;
    let proxy = StratumTcpProxy::new(outbox.clone(), sessions)
        .with_upstream_authorization(upstream_authorization);
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let proxy_task = AbortTaskOnDrop::new(tokio::spawn(async move {
        proxy.serve_one(&listener, hydra_address).await
    }));
    let worker = TcpStream::connect(address).await?;
    let (worker_read, mut worker_write) = worker.into_split();
    let mut worker_lines = BufReader::new(worker_read).lines();
    write_line(
        &mut worker_write,
        r#"{"id":11,"method":"mining.subscribe","params":[]}"#,
    )
    .await?;
    let subscribed = next_matching(&mut worker_lines, |value| value["id"] == 11)
        .await
        .map_err(|error| format!("waiting for reconnect subscribe: {error}"))?;
    let extranonce1 = subscribed["result"][1]
        .as_str()
        .ok_or("reconnect response must include extranonce1")?
        .to_owned();
    let extranonce2 = "00".repeat(usize::try_from(
        subscribed["result"][2]
            .as_u64()
            .ok_or("reconnect response must include extranonce2 size")?,
    )?);
    write_line(
        &mut worker_write,
        &format!(
            r#"{{"id":12,"method":"mining.authorize","params":["{}","{}"]}}"#,
            credentials.username(),
            credentials.secret()
        ),
    )
    .await?;
    let mut observed = Vec::new();
    let authorized =
        next_matching_recording(&mut worker_lines, |value| value["id"] == 12, &mut observed)
            .await?;
    let notify = next_matching_recording(
        &mut worker_lines,
        |value| value["method"] == "mining.notify",
        &mut observed,
    )
    .await?;
    assert_eq!(authorized["result"], true);
    assert_ne!(extranonce1, first_extranonce);
    let difficulty = observed
        .iter()
        .find(|value| value["method"] == "mining.set_difficulty")
        .map(|value| value["params"][0].clone())
        .ok_or("reconnect must assign difficulty")?;
    let params = notify["params"]
        .as_array()
        .ok_or("reconnect notify params must be an array")?;
    let winning_nonce = worked_nonce(
        params,
        &extranonce1,
        &extranonce2,
        assigned_target(&difficulty)?,
        true,
        0,
    )?;
    let block_count_before = regtest_block_count().await?;
    database.pause().await?;
    let submission_started = std::time::Instant::now();
    write_line(
        &mut worker_write,
        &format!(
            r#"{{"id":13,"method":"mining.submit","params":["{}","{}","{extranonce2}","{}","{winning_nonce}"]}}"#,
            credentials.username(),
            params[0].as_str().ok_or("winning job ID")?,
            params[7].as_str().ok_or("winning ntime")?
        ),
    )
    .await?;
    wait_for_block_height(block_count_before + 1).await?;
    let submission_latency = submission_started.elapsed();
    assert!(submission_latency < Duration::from_secs(5));
    drop(worker_lines);
    drop(worker_write);
    let observer_outcome = match proxy_task.finish(Duration::from_secs(2)).await? {
        TaskCompletion::Completed(proxy_result) => match proxy_result {
            Err(StratumV1Error::Database(_)) => "database_error",
            Ok(()) => "upstream_closed",
            Err(error) => return Err(error.into()),
        },
        TaskCompletion::DeadlineAborted => "timeout_aborted",
    };
    let accepted_block_hash = regtest_best_block_hash().await?;
    invalidate_regtest_block(&accepted_block_hash).await?;
    assert_eq!(regtest_block_count().await?, block_count_before);
    reconsider_regtest_block(&accepted_block_hash).await?;
    wait_for_block_height(block_count_before + 1).await?;
    database.resume().await?;
    let recovered_authority =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let (recovery_url, _recovery_address, recovery_task) =
        spawn_http(authority::router(recovered_authority)).await?;
    let recovery_task = AbortTaskOnDrop::new(recovery_task);
    let issued_pass_after = lookup_gate_pass(
        &recovery_url,
        challenge_id,
        claimant,
        "proof_hydra_after_reorg_01",
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),
    )
    .await?;
    recovery_task.abort().await?;
    assert_eq!(issued_pass_after, issued_pass_before);
    write_block_submission_evidence(submission_latency, &accepted_block_hash, observer_outcome)
}

fn write_block_submission_evidence(
    submission_latency: Duration,
    block_hash: &str,
    observer_outcome: &str,
) -> Result<(), Box<dyn Error>> {
    let evidence_path = std::env::var("BWG_BLOCK_SUBMISSION_EVIDENCE_PATH")?;
    std::fs::write(
        evidence_path,
        format!(
            "submission_latency_milliseconds={}\nblock_hash={block_hash}\ncore_result=accepted\nobserver_outcome={observer_outcome}\nauthority_outage=true\ndatabase_outage=true\nsse_outage=true\nrelying_service_outage=true\nreorg_observed=true\ngate_pass_status=issued\ngate_pass_bytes_unchanged=true\ngate_credit_policy=assigned_target_only\nresidual_risk=winning_share_uncredited_when_observer_database_is_unavailable\n",
            submission_latency.as_millis()
        ),
    )?;
    Ok(())
}
