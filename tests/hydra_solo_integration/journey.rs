use super::*;

pub(super) struct InitialWorker {
    first_extranonce: String,
    worker_lines: tokio::io::Lines<BufReader<OwnedReadHalf>>,
    worker_write: OwnedWriteHalf,
    proxy_task: tokio::task::JoinHandle<Result<(), StratumV1Error>>,
}

pub(super) async fn run_initial_worker(
    fixture: &IntegrationFixture,
) -> Result<InitialWorker, Box<dyn Error>> {
    let proxy = StratumTcpProxy::new(fixture.outbox.clone(), fixture.sessions.clone())
        .with_upstream_authorization(fixture.upstream_authorization.clone());
    let proxy_listener = TcpListener::bind("127.0.0.1:0").await?;
    let proxy_address = proxy_listener.local_addr()?;
    let hydra_address = fixture.hydra_address;
    let mut proxy_task =
        tokio::spawn(async move { proxy.serve_one(&proxy_listener, hydra_address).await });
    let worker = TcpStream::connect(proxy_address).await?;
    let (worker_read, mut worker_write) = worker.into_split();
    let mut worker_lines = BufReader::new(worker_read).lines();
    write_line(
        &mut worker_write,
        r#"{"id":1,"method":"mining.subscribe","params":[]}"#,
    )
    .await?;
    let subscribed = next_matching(&mut worker_lines, |value| value["id"] == 1)
        .await
        .map_err(|error| format!("waiting for subscribe: {error}"))?;
    let first_extranonce = subscribed["result"][1]
        .as_str()
        .ok_or("Hydra subscribe response must include extranonce1")?
        .to_owned();
    let extranonce2_size = subscribed["result"][2]
        .as_u64()
        .ok_or("Hydra subscribe response must include extranonce2 size")?;
    write_line(
        &mut worker_write,
        &format!(
            r#"{{"id":2,"method":"mining.authorize","params":["{}","{}"]}}"#,
            fixture.credentials.username(),
            fixture.credentials.secret()
        ),
    )
    .await?;
    let mut observed = Vec::new();
    let authorized =
        next_matching_recording(&mut worker_lines, |value| value["id"] == 2, &mut observed)
            .await
            .map_err(|error| format!("waiting for authorize: {error}"))?;
    let notify = next_matching_recording(
        &mut worker_lines,
        |value| value["method"] == "mining.notify",
        &mut observed,
    )
    .await
    .map_err(|error| format!("waiting for initial job: {error}"))?;
    let params = notify["params"]
        .as_array()
        .ok_or("Hydra notify params must be an array")?;
    let coinbase2 = params[3]
        .as_str()
        .ok_or("Hydra coinbase2 must be a string")?
        .to_ascii_lowercase();
    let coinbase1 = params[2]
        .as_str()
        .ok_or("Hydra coinbase1 must be a string")?;
    let extranonce2 = "00".repeat(usize::try_from(extranonce2_size)?);
    let coinbase_bytes = Vec::<u8>::from_hex(&format!(
        "{coinbase1}{first_extranonce}{extranonce2}{coinbase2}"
    ))?;
    let coinbase = deserialize::<Transaction>(&coinbase_bytes)?;
    exercise_vardiff(
        &mut worker_lines,
        &mut worker_write,
        &mut proxy_task,
        VardiffInput {
            username: fixture.credentials.username(),
            params,
            observed: &observed,
            extranonce1: &first_extranonce,
            extranonce2: &extranonce2,
        },
    )
    .await?;

    assert_eq!(authorized["result"], true);
    assert_eq!(coinbase.output.len(), 2);
    assert_eq!(coinbase.output[0].script_pubkey, fixture.payout_script);
    assert_eq!(coinbase.output[0].value, Amount::from_sat(5_000_000_000));
    assert_eq!(coinbase.output[1].value, Amount::ZERO);
    assert!(coinbase.output[1].script_pubkey.is_op_return());

    Ok(InitialWorker {
        first_extranonce,
        worker_lines,
        worker_write,
        proxy_task,
    })
}

pub(super) async fn issue_gate_pass(
    fixture: &IntegrationFixture,
) -> Result<IssuedPassSnapshot, Box<dyn Error>> {
    let delivery = AcceptedWorkDeliveryWorker::new(
        fixture.outbox.clone(),
        "delivery_worker_hydra_integration".to_owned(),
        30,
    )?;
    let sink = AuthoritySink {
        adapter: fixture.adapter.clone(),
        state: Mutex::new(AuthoritySinkState {
            progress: Vec::new(),
            maybe_latest_lease_context: None,
        }),
    };
    let mut delivered_count = 0;
    for offset in 1..=5 {
        match delivery.deliver_one(&sink, fixture.now + offset).await? {
            DeliveryOutcome::Acknowledged => delivered_count += 1,
            DeliveryOutcome::Empty => break,
            DeliveryOutcome::RetryableFailure => return Err("Authority delivery failed".into()),
        }
    }
    let sink_state = sink.state.into_inner()?;
    let latest_lease_context = sink_state
        .maybe_latest_lease_context
        .ok_or("Hydra delivery must retain its latest lease context")?;
    let progress = sink_state.progress;
    let issuance_precondition = fixture
        .adapter
        .report_stratum(
            issuance_qualifying_event(fixture.credentials.session_id().clone())?,
            &latest_lease_context,
        )
        .await?;
    let issuance = fixture
        .authority_application
        .process_next_issuance(
            &IssuanceWorkerId::try_from("worker_hydra_solo_integration_01".to_owned())?,
            fixture.now,
        )
        .await?;
    if !matches!(
        &issuance,
        IssuanceProcessingOutcome::Issued {
            challenge_id: issued_challenge_id
        } if issued_challenge_id == &fixture.challenge_id
    ) {
        return Err(format!(
            "expected Gate Pass for {}, got {issuance:?}",
            fixture.challenge_id.as_str()
        )
        .into());
    }
    let issued_pass = lookup_gate_pass(
        &format!("http://{}", fixture.authority_address),
        &fixture.challenge_id,
        &fixture.claimant,
        "proof_hydra_before_outages_01",
        fixture.now,
    )
    .await?;

    assert_eq!(delivered_count, 4);
    assert_eq!(progress.len(), 4);
    assert!(issuance_precondition.issuance_intent_created());
    assert!(
        progress
            .last()
            .ok_or("progress must exist")?
            .parse::<u128>()?
            >= 4
    );
    assert_eq!(issued_pass.status, "issued");
    Ok(issued_pass)
}

pub(super) async fn close_initial_worker_after_gate_outage(
    fixture: &mut IntegrationFixture,
    initial_worker: InitialWorker,
) -> Result<String, Box<dyn Error>> {
    let InitialWorker {
        first_extranonce,
        mut worker_lines,
        worker_write,
        proxy_task,
    } = initial_worker;
    fixture.reference_task.abort();
    assert!(
        (&mut fixture.reference_task)
            .await
            .is_err_and(|error| error.is_cancelled())
    );
    assert!(TcpStream::connect(fixture.reference_address).await.is_err());
    fixture.authority_task.abort();
    assert!(
        (&mut fixture.authority_task)
            .await
            .is_err_and(|error| error.is_cancelled())
    );
    assert!(TcpStream::connect(fixture.authority_address).await.is_err());
    mine_regtest_block().await?;
    wait_for_close(&mut worker_lines).await?;
    drop(worker_lines);
    drop(worker_write);
    assert!(proxy_task.await?.is_ok());
    Ok(first_extranonce)
}
