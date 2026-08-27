use super::*;

#[tokio::test]
#[ignore = "run through scripts/verify-hydra-solo-integration.sh"]
async fn mismatched_consent_session_fails_closed_and_releases_extranonce()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let IntegrationFixture {
        database: _database,
        authority_task,
        reference_task,
        hydra_address,
        outbox,
        sessions,
        adapter,
        credentials,
        upstream_authorization,
        now,
        ..
    } = arrange_integration().await?;
    let mismatched_credentials = StratumCredentialIssuer::new([47_u8; 32]).issue(
        WorkSessionId::try_from("session_hydra_consent_mismatch_01".to_owned())?,
        credentials.lease_context().clone(),
        now,
        now + 60,
        now + 300,
    )?;
    sessions.register(&mismatched_credentials).await?;
    let proxy = StratumTcpProxy::new(outbox, sessions.clone(), Arc::new(adapter))
        .with_upstream_authorization(upstream_authorization);
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let proxy_address = listener.local_addr()?;
    let proxy_task = tokio::spawn(async move { proxy.serve_one(&listener, hydra_address).await });
    let worker = TcpStream::connect(proxy_address).await?;
    let (worker_read, mut worker_write) = worker.into_split();
    let mut worker_lines = BufReader::new(worker_read).lines();
    write_line(
        &mut worker_write,
        r#"{"id":21,"method":"mining.subscribe","params":[]}"#,
    )
    .await?;
    let subscribed = next_matching(&mut worker_lines, |value| value["id"] == 21).await?;
    let reserved_extranonce = subscribed["result"][1]
        .as_str()
        .ok_or("subscribe response must contain extranonce1")?
        .to_owned();

    // Act
    write_line(
        &mut worker_write,
        &format!(
            r#"{{"id":22,"method":"mining.authorize","params":["{}","{}"]}}"#,
            mismatched_credentials.username(),
            mismatched_credentials.secret()
        ),
    )
    .await?;
    wait_for_close(&mut worker_lines).await?;
    let proxy_result = proxy_task.await?;
    let replacement_connection_id = uuid::Uuid::new_v4().to_string();
    let replacement_reservation = sessions
        .reserve_connection(&replacement_connection_id, &reserved_extranonce, now + 1)
        .await;

    // Assert
    assert!(matches!(proxy_result, Err(StratumV1Error::UnknownSession)));
    assert!(replacement_reservation.is_ok());
    sessions
        .release_unbound_connection(&replacement_connection_id)
        .await?;
    authority_task.abort();
    assert!(
        authority_task
            .await
            .is_err_and(|error| error.is_cancelled())
    );
    reference_task.abort();
    assert!(
        reference_task
            .await
            .is_err_and(|error| error.is_cancelled())
    );
    Ok(())
}
