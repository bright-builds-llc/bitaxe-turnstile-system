use super::*;

#[tokio::test]
async fn unacknowledged_event_is_reclaimed_exactly_after_restart() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let outbox = PostgresAcceptedWorkOutbox::connect(database.database_url()).await?;
    let event = persisted_event("event_stratum_outbox_01", "share_stratum_outbox_01")?;
    let lease_context = test_lease_context()?;
    let worker_response = r#"{"id":11,"result":true,"error":null}"#;
    outbox
        .persist(&event, &lease_context, worker_response)
        .await?;
    let first_claim = outbox
        .claim_next("delivery_worker_01", 1_000, 1_030)
        .await?
        .ok_or("persisted event must be claimable")?;
    assert_eq!(first_claim.event(), &event);
    drop(outbox);
    let restarted = PostgresAcceptedWorkOutbox::connect(database.database_url()).await?;

    // Act
    let while_leased = restarted
        .claim_next("delivery_worker_02", 1_029, 1_059)
        .await?;
    let recovered = restarted
        .claim_next("delivery_worker_02", 1_030, 1_060)
        .await?
        .ok_or("expired delivery lease must be recoverable")?;
    restarted.acknowledge(&recovered, 1_031).await?;
    let after_ack = restarted
        .claim_next("delivery_worker_03", 1_061, 1_091)
        .await?;

    // Assert
    assert!(while_leased.is_none());
    assert_eq!(recovered.event(), first_claim.event());
    assert_eq!(recovered.lease_context(), &lease_context);
    assert_eq!(recovered.worker_response(), worker_response);
    assert!(after_ack.is_none());
    Ok(())
}

#[tokio::test]
async fn session_authentication_and_extranonce_reservation_survive_restart()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let issuer = StratumCredentialIssuer::new([8_u8; 32]);
    let first_session = WorkSessionId::try_from("session_stratum_registry_01".to_owned())?;
    let second_session = WorkSessionId::try_from("session_stratum_registry_02".to_owned())?;
    let first = issuer.issue(
        first_session.clone(),
        test_lease_context()?,
        1_000,
        1_060,
        2_000,
    )?;
    let second = issuer.issue(
        second_session.clone(),
        test_lease_context()?,
        1_000,
        1_060,
        2_000,
    )?;
    let registry = PostgresStratumSessionRegistry::connect(database.database_url()).await?;
    registry.register(&first).await?;
    registry.register(&second).await?;
    drop(registry);
    let restarted = PostgresStratumSessionRegistry::connect(database.database_url()).await?;

    // Act
    let authenticated = restarted
        .authenticate(first.username(), first.secret(), 1_000)
        .await?
        .ok_or("registered credentials must authenticate after restart")?;
    let wrong_secret = restarted
        .authenticate(first.username(), "wrong-secret", 1_000)
        .await?;
    let expired = restarted
        .authenticate(first.username(), first.secret(), 1_060)
        .await?;
    restarted
        .reserve_extranonce(
            &first_session,
            "00000000-0000-4000-8000-000000000001",
            "aAbB",
            1_000,
        )
        .await?;
    let replay = restarted
        .reserve_extranonce(
            &first_session,
            "00000000-0000-4000-8000-000000000001",
            "aabb",
            1_000,
        )
        .await;
    let reconnect = restarted
        .reserve_extranonce(
            &first_session,
            "00000000-0000-4000-8000-000000000002",
            "05060708",
            1_001,
        )
        .await;
    let collision = restarted
        .reserve_extranonce(
            &second_session,
            "00000000-0000-4000-8000-000000000003",
            "AABB",
            1_001,
        )
        .await;

    // Assert
    assert_eq!(authenticated.session_id(), &first_session);
    assert!(wrong_secret.is_none());
    assert!(expired.is_none());
    assert!(replay.is_ok());
    assert!(reconnect.is_ok());
    assert!(matches!(
        collision,
        Err(StratumV1Error::ExtranonceCollision)
    ));
    Ok(())
}

#[tokio::test]
async fn renewed_session_credentials_rotate_without_allowing_generation_rollback()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let registry = PostgresStratumSessionRegistry::connect(database.database_url()).await?;
    let issuer = StratumCredentialIssuer::new([18_u8; 32]);
    let session_id = WorkSessionId::try_from("session_stratum_rotation_01".to_owned())?;
    let first = issuer.issue(
        session_id.clone(),
        test_lease_context()?,
        1_000,
        1_060,
        2_000,
    )?;
    let renewed = issuer.issue(session_id, test_lease_context()?, 1_001, 1_060, 2_000)?;
    registry.register(&first).await?;

    // Act
    registry.register(&renewed).await?;
    let old_authentication = registry
        .authenticate(first.username(), first.secret(), 1_001)
        .await?;
    let renewed_authentication = registry
        .authenticate(renewed.username(), renewed.secret(), 1_001)
        .await?;
    let rollback = registry.register(&first).await;

    // Assert
    assert!(old_authentication.is_none());
    assert!(renewed_authentication.is_some());
    assert!(matches!(
        rollback,
        Err(StratumV1Error::ConflictingSessionReplay)
    ));
    Ok(())
}

#[tokio::test]
async fn delivery_retries_the_exact_event_until_the_authority_acknowledges()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let outbox = PostgresAcceptedWorkOutbox::connect(database.database_url()).await?;
    let event = persisted_event("event_stratum_delivery_01", "share_stratum_delivery_01")?;
    outbox
        .persist(
            &event,
            &test_lease_context()?,
            r#"{"id":12,"result":true,"error":null}"#,
        )
        .await?;
    let sink = RecordingSink::fail_once();
    let worker = AcceptedWorkDeliveryWorker::new(outbox, "delivery_worker_retry".to_owned(), 30)?;

    // Act
    let failed = worker.deliver_one(&sink, 1_000).await?;
    let while_leased = worker.deliver_one(&sink, 1_029).await?;
    let recovered = worker.deliver_one(&sink, 1_030).await?;
    let complete = worker.deliver_one(&sink, 1_061).await?;

    // Assert
    assert_eq!(failed, DeliveryOutcome::RetryableFailure);
    assert_eq!(while_leased, DeliveryOutcome::Empty);
    assert_eq!(recovered, DeliveryOutcome::Acknowledged);
    assert_eq!(complete, DeliveryOutcome::Empty);
    assert_eq!(sink.attempts(), vec![event.clone(), event]);
    Ok(())
}

#[tokio::test]
async fn tcp_proxy_forwards_standard_frames_and_persists_before_accepted_response()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let outbox = PostgresAcceptedWorkOutbox::connect(database.database_url()).await?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let session_id = WorkSessionId::try_from("session_stratum_tcp_01".to_owned())?;
    let credentials = StratumCredentialIssuer::new([7_u8; 32]).issue(
        session_id.clone(),
        test_lease_context()?,
        now,
        now + 60,
        now + 300,
    )?;
    let username = credentials.username().to_owned();
    let secret = credentials.secret().to_owned();
    let upstream_listener = TcpListener::bind("127.0.0.1:0").await?;
    let upstream_address = upstream_listener.local_addr()?;
    let upstream_task = tokio::spawn(simulated_upstream(
        upstream_listener,
        username.clone(),
        secret.clone(),
    ));
    let proxy_listener = TcpListener::bind("127.0.0.1:0").await?;
    let proxy_address = proxy_listener.local_addr()?;
    let session_registry = PostgresStratumSessionRegistry::connect(database.database_url()).await?;
    session_registry.register(&credentials).await?;
    let proxy = StratumTcpProxy::new(outbox.clone(), session_registry);
    let proxy_task =
        tokio::spawn(async move { proxy.serve_one(&proxy_listener, upstream_address).await });
    let worker = TcpStream::connect(proxy_address).await?;
    let (worker_read, mut worker_write) = worker.into_split();
    let mut worker_lines = BufReader::new(worker_read).lines();

    // Act
    write_line(
        &mut worker_write,
        r#"{"id":1,"method":"mining.subscribe","params":[]}"#,
    )
    .await?;
    assert!(
        worker_lines
            .next_line()
            .await?
            .is_some_and(|line| line.contains("01020304"))
    );
    write_line(
        &mut worker_write,
        &format!(r#"{{"id":2,"method":"mining.authorize","params":["{username}","{secret}"]}}"#),
    )
    .await?;
    assert_eq!(
        worker_lines.next_line().await?,
        Some(r#"{"id":2,"result":true,"error":null}"#.to_owned())
    );
    assert!(
        worker_lines
            .next_line()
            .await?
            .is_some_and(|line| line.contains("mining.set_difficulty"))
    );
    assert!(
        worker_lines
            .next_line()
            .await?
            .is_some_and(|line| line.contains("job-tcp-01"))
    );
    write_line(
        &mut worker_write,
        &format!(r#"{{"id":3,"method":"mining.submit","params":["{username}","job-tcp-01","00000001","5f5e1000","abcdef01"]}}"#),
    )
    .await?;
    let accepted = worker_lines
        .next_line()
        .await?
        .ok_or("proxy closed before accepted response")?;
    let claimed = outbox
        .claim_next("delivery_worker_tcp", now, now + 30)
        .await?
        .ok_or("accepted Worker response requires a durable outbox event")?;

    // Assert
    assert_eq!(accepted, r#"{"id":3,"result":true,"error":null}"#);
    assert_eq!(claimed.event().work_session_id(), &session_id);
    assert_eq!(claimed.worker_response(), accepted);
    drop(worker_lines);
    drop(worker_write);
    upstream_task.await??;
    proxy_task.await??;
    Ok(())
}

#[tokio::test]
async fn reconnect_replays_one_exact_outbox_event() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let outbox = PostgresAcceptedWorkOutbox::connect(database.database_url()).await?;
    let mut first = prepared_submit_session(
        "session_stratum_reconnect_01",
        "worker-reconnect-01",
        71,
        "21222324",
        1_060,
    )?;
    let mut reconnected = prepared_submit_session(
        "session_stratum_reconnect_01",
        "worker-reconnect-01",
        71,
        "21222324",
        1_060,
    )?;
    let accepted = r#"{"id":71,"result":true,"error":null}"#;

    // Act
    let first_actions = first.upstream_frame(accepted, 1_002)?;
    let replay_actions = reconnected.upstream_frame(accepted, 1_012)?;
    let [
        StratumProxyAction::PersistAccepted {
            event: first_event,
            lease_context: first_lease_context,
            worker_response: first_response,
            token: _,
        },
    ] = first_actions.as_slice()
    else {
        return Err("first accepted result must request persistence".into());
    };
    let [
        StratumProxyAction::PersistAccepted {
            event: replay_event,
            lease_context: replay_lease_context,
            worker_response: replay_response,
            token: _,
        },
    ] = replay_actions.as_slice()
    else {
        return Err("reconnected result must request persistence".into());
    };
    let first_persisted = outbox
        .persist(first_event, first_lease_context, first_response)
        .await?;
    let replay_persisted = outbox
        .persist(replay_event, replay_lease_context, replay_response)
        .await?;
    let later_observation = StratumLeaseContext::new(
        first_lease_context.lease_id().to_owned(),
        first_lease_context.continuity_id().to_owned(),
        first_lease_context.last_monotonic_milliseconds() + 1_000,
        first_lease_context.renew_at_monotonic_milliseconds() + 10_000,
        first_lease_context.expires_at_monotonic_milliseconds() + 10_000,
    )?;
    let later_persisted = outbox
        .persist(replay_event, &later_observation, replay_response)
        .await?;
    let claimed = outbox
        .claim_next("delivery_worker_reconnect", 1_010, 1_040)
        .await?
        .ok_or("reconnected event must remain claimable")?;

    // Assert
    assert_ne!(replay_event, first_event);
    assert_eq!(
        replay_event.share_fingerprint(),
        first_event.share_fingerprint()
    );
    assert_eq!(replay_persisted.event(), first_persisted.event());
    assert_eq!(
        replay_persisted.lease_context(),
        first_persisted.lease_context()
    );
    assert_eq!(
        later_persisted.lease_context(),
        first_persisted.lease_context()
    );
    assert_eq!(replay_lease_context, first_lease_context);
    assert_eq!(replay_persisted.worker_response(), first_response);
    assert_eq!(claimed.event(), first_persisted.event());
    assert!(
        outbox
            .claim_next("delivery_worker_reconnect_2", 1_011, 1_041)
            .await?
            .is_none()
    );
    Ok(())
}
