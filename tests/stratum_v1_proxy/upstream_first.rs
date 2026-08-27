use std::{
    error::Error,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use bwg_core::{
    progress::WorkSessionId,
    stratum_v1::{
        PostgresAcceptedWorkOutbox, PostgresStratumSessionRegistry, StratumCredentialIssuer,
        StratumProxyAction, StratumTcpProxy, StratumV1Error, WorkSessionDisconnectSink,
        WorkSessionDisconnectSinkError,
    },
};
use tokio::{
    io::{AsyncBufReadExt as _, BufReader},
    net::{TcpListener, TcpStream},
    sync::oneshot,
    time::{Duration, timeout},
};

use super::{
    PostgresTestDatabase, StratumJobFields, authorized_session, hex_target, test_lease_context,
    worked_nonce, write_line,
};

use super::fixtures::disconnect_sink;

#[tokio::test]
async fn established_worker_disconnect_notifies_its_session_sink() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let outbox = PostgresAcceptedWorkOutbox::connect(database.database_url()).await?;
    let sessions = PostgresStratumSessionRegistry::connect(database.database_url()).await?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let session_id = WorkSessionId::try_from("session_disconnect_sink_01".to_owned())?;
    let credentials = StratumCredentialIssuer::new([33_u8; 32]).issue(
        session_id.clone(),
        test_lease_context()?,
        now,
        now + 60,
        now + 300,
    )?;
    sessions.register(&credentials).await?;
    let username = credentials.username().to_owned();
    let secret = credentials.secret().to_owned();
    let sink = Arc::new(RecordingDisconnectSink::default());
    let proxy = StratumTcpProxy::new(outbox, sessions, sink.clone());
    let upstream_listener = TcpListener::bind("127.0.0.1:0").await?;
    let upstream_address = upstream_listener.local_addr()?;
    let upstream_task = tokio::spawn(async move {
        let (stream, _) = upstream_listener.accept().await?;
        let (read, mut write) = stream.into_split();
        let mut lines = BufReader::new(read).lines();
        let _subscribe = lines.next_line().await?;
        write_line(
            &mut write,
            r#"{"id":1,"result":[[["mining.notify","disconnect-sink"]],"01020304",4],"error":null}"#,
        )
        .await?;
        let _authorize = lines.next_line().await?;
        write_line(&mut write, r#"{"id":2,"result":true,"error":null}"#).await?;
        let _closed = lines.next_line().await?;
        Ok::<(), std::io::Error>(())
    });
    let proxy_listener = TcpListener::bind("127.0.0.1:0").await?;
    let proxy_address = proxy_listener.local_addr()?;
    let proxy_task =
        tokio::spawn(async move { proxy.serve_one(&proxy_listener, upstream_address).await });
    let worker = TcpStream::connect(proxy_address).await?;
    let (worker_read, mut worker_write) = worker.into_split();
    let mut worker_lines = BufReader::new(worker_read).lines();
    write_line(
        &mut worker_write,
        r#"{"id":1,"method":"mining.subscribe","params":[]}"#,
    )
    .await?;
    let _subscribed = worker_lines.next_line().await?;
    write_line(
        &mut worker_write,
        &format!(r#"{{"id":2,"method":"mining.authorize","params":["{username}","{secret}"]}}"#,),
    )
    .await?;
    let _authorized = worker_lines.next_line().await?;

    // Act
    drop(worker_lines);
    drop(worker_write);
    let proxy_result = proxy_task.await?;
    upstream_task.await??;

    // Assert
    assert!(proxy_result.is_ok());
    let disconnected_sessions = sink
        .session_ids
        .lock()
        .map_err(|_| "disconnect sink lock was poisoned")?
        .clone();
    assert_eq!(disconnected_sessions, [session_id]);
    Ok(())
}

#[derive(Default)]
struct RecordingDisconnectSink {
    session_ids: Mutex<Vec<WorkSessionId>>,
}

#[async_trait]
impl WorkSessionDisconnectSink for RecordingDisconnectSink {
    async fn disconnected(
        &self,
        session_id: &WorkSessionId,
    ) -> Result<(), WorkSessionDisconnectSinkError> {
        self.session_ids
            .lock()
            .map_err(|_| WorkSessionDisconnectSinkError::Unavailable)?
            .push(session_id.clone());
        Ok(())
    }
}

#[tokio::test]
async fn subscription_success_is_hidden_when_extranonce_reservation_fails()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let outbox = PostgresAcceptedWorkOutbox::connect(database.database_url()).await?;
    let sessions = PostgresStratumSessionRegistry::connect(database.database_url()).await?;
    let proxy = StratumTcpProxy::new(outbox, sessions.clone(), disconnect_sink());
    sessions.close().await;
    let upstream_listener = TcpListener::bind("127.0.0.1:0").await?;
    let upstream_address = upstream_listener.local_addr()?;
    let upstream_task = tokio::spawn(async move {
        let (stream, _) = upstream_listener.accept().await?;
        let (read, mut write) = stream.into_split();
        let mut lines = BufReader::new(read).lines();
        let _subscribe = lines.next_line().await?;
        write_line(
            &mut write,
            r#"{"id":1,"result":[[["mining.notify","reservation-failure"]],"01020304",4],"error":null}"#,
        )
        .await
    });
    let proxy_listener = TcpListener::bind("127.0.0.1:0").await?;
    let proxy_address = proxy_listener.local_addr()?;
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
    let worker_response = timeout(Duration::from_secs(2), worker_lines.next_line()).await??;
    let proxy_result = proxy_task.await?;

    // Assert
    assert!(worker_response.is_none());
    assert!(matches!(proxy_result, Err(StratumV1Error::Database(_))));
    upstream_task.await??;
    Ok(())
}

#[tokio::test]
async fn disconnect_before_authorize_releases_the_unbound_extranonce() -> Result<(), Box<dyn Error>>
{
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let outbox = PostgresAcceptedWorkOutbox::connect(database.database_url()).await?;
    let sessions = PostgresStratumSessionRegistry::connect(database.database_url()).await?;
    let proxy = StratumTcpProxy::new(outbox, sessions.clone(), disconnect_sink());
    let upstream_listener = TcpListener::bind("127.0.0.1:0").await?;
    let upstream_address = upstream_listener.local_addr()?;
    let upstream_task = tokio::spawn(async move {
        let (stream, _) = upstream_listener.accept().await?;
        let (read, mut write) = stream.into_split();
        let mut lines = BufReader::new(read).lines();
        let _subscribe = lines.next_line().await?;
        write_line(
            &mut write,
            r#"{"id":1,"result":[[["mining.notify","disconnect-cleanup"]],"aabbccdd",4],"error":null}"#,
        )
        .await
    });
    let proxy_listener = TcpListener::bind("127.0.0.1:0").await?;
    let proxy_address = proxy_listener.local_addr()?;
    let proxy_task =
        tokio::spawn(async move { proxy.serve_one(&proxy_listener, upstream_address).await });
    let worker = TcpStream::connect(proxy_address).await?;
    let (worker_read, mut worker_write) = worker.into_split();
    let mut worker_lines = BufReader::new(worker_read).lines();
    write_line(
        &mut worker_write,
        r#"{"id":1,"method":"mining.subscribe","params":[]}"#,
    )
    .await?;
    let subscribed = worker_lines.next_line().await?;

    // Act
    drop(worker_lines);
    drop(worker_write);
    let proxy_result = proxy_task.await?;
    let reusable = sessions
        .reserve_connection("00000000-0000-4000-8000-000000000203", "AABBCCDD", 2_000)
        .await;

    // Assert
    assert!(subscribed.is_some());
    assert!(matches!(proxy_result, Err(StratumV1Error::InvalidFrame)));
    assert!(reusable.is_ok());
    upstream_task.await??;
    Ok(())
}

#[tokio::test]
async fn cleanup_outage_is_reported_alongside_the_admission_failure() -> Result<(), Box<dyn Error>>
{
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let outbox = PostgresAcceptedWorkOutbox::connect(database.database_url()).await?;
    let sessions = PostgresStratumSessionRegistry::connect(database.database_url()).await?;
    let proxy = StratumTcpProxy::new(outbox, sessions.clone(), disconnect_sink());
    let upstream_listener = TcpListener::bind("127.0.0.1:0").await?;
    let upstream_address = upstream_listener.local_addr()?;
    let upstream_task = tokio::spawn(async move {
        let (stream, _) = upstream_listener.accept().await?;
        let (read, mut write) = stream.into_split();
        let mut lines = BufReader::new(read).lines();
        let _subscribe = lines.next_line().await?;
        write_line(
            &mut write,
            r#"{"id":1,"result":[[["mining.notify","cleanup-outage"]],"deadbeef",4],"error":null}"#,
        )
        .await
    });
    let proxy_listener = TcpListener::bind("127.0.0.1:0").await?;
    let proxy_address = proxy_listener.local_addr()?;
    let proxy_task =
        tokio::spawn(async move { proxy.serve_one(&proxy_listener, upstream_address).await });
    let worker = TcpStream::connect(proxy_address).await?;
    let (worker_read, mut worker_write) = worker.into_split();
    let mut worker_lines = BufReader::new(worker_read).lines();
    write_line(
        &mut worker_write,
        r#"{"id":1,"method":"mining.subscribe","params":[]}"#,
    )
    .await?;
    let _subscribed = worker_lines.next_line().await?;

    // Act
    sessions.close().await;
    drop(worker_lines);
    drop(worker_write);
    let proxy_result = proxy_task.await?;

    // Assert
    assert!(matches!(
        proxy_result,
        Err(StratumV1Error::AdmissionCleanup { admission, cleanup })
            if matches!(*admission, StratumV1Error::InvalidFrame)
                && matches!(*cleanup, StratumV1Error::Database(_))
    ));
    upstream_task.await??;
    Ok(())
}

#[test]
fn observer_reconstruction_failure_cannot_prevent_upstream_submit() -> Result<(), Box<dyn Error>> {
    // Arrange
    let mut session = authorized_session()?;
    session.worker_frame(
        r#"{"id":70,"method":"mining.subscribe","params":[]}"#,
        1_000,
    )?;
    let actions = session.upstream_frame(
        r#"{"id":70,"result":[[["mining.notify","observer-failure"]],"01020304",4],"error":null}"#,
        1_000,
    )?;
    let [StratumProxyAction::ReserveExtranonce { token, .. }] = actions.as_slice() else {
        return Err("subscription must request extranonce reservation".into());
    };
    let _ = session.extranonce_reserved(token)?;
    session.upstream_frame(
        r#"{"id":null,"method":"mining.set_difficulty","params":[1]}"#,
        1_000,
    )?;
    session.upstream_frame(
        r#"{"id":null,"method":"mining.notify","params":["job-observer-failure","0000000000000000000000000000000000000000000000000000000000000000","not-hex","00",[],"20000000","207fffff","5f5e1000",true]}"#,
        1_000,
    )?;
    let submit = r#"{"id":71,"method":"mining.submit","params":["bwg-session-stale","job-observer-failure","00000001","5f5e1000","00000003"]}"#;

    // Act
    let actions = session.worker_frame(submit, 1_001)?;
    let observer_result = session.upstream_frame(r#"{"id":71,"result":true,"error":null}"#, 1_002);

    // Assert
    assert_eq!(
        actions,
        [StratumProxyAction::ForwardUpstream(submit.to_owned())]
    );
    assert!(matches!(observer_result, Err(StratumV1Error::InvalidFrame)));
    Ok(())
}

#[tokio::test]
async fn upstream_receives_submit_before_noncritical_outbox_failure() -> Result<(), Box<dyn Error>>
{
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let outbox = PostgresAcceptedWorkOutbox::connect(database.database_url()).await?;
    let sessions = PostgresStratumSessionRegistry::connect(database.database_url()).await?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let session_id = WorkSessionId::try_from("session_stratum_upstream_first_01".to_owned())?;
    let credentials = StratumCredentialIssuer::new([9_u8; 32]).issue(
        session_id,
        test_lease_context()?,
        now,
        now + 60,
        now + 300,
    )?;
    let username = credentials.username().to_owned();
    let secret = credentials.secret().to_owned();
    sessions.register(&credentials).await?;
    let upstream_listener = TcpListener::bind("127.0.0.1:0").await?;
    let upstream_address = upstream_listener.local_addr()?;
    let (submitted_tx, submitted_rx) = oneshot::channel();
    let upstream_task = tokio::spawn(upstream_until_submit(
        upstream_listener,
        username.clone(),
        secret.clone(),
        submitted_tx,
    ));
    let proxy_listener = TcpListener::bind("127.0.0.1:0").await?;
    let proxy_address = proxy_listener.local_addr()?;
    let proxy = StratumTcpProxy::new(outbox.clone(), sessions, disconnect_sink());
    outbox.close().await;
    let proxy_task =
        tokio::spawn(async move { proxy.serve_one(&proxy_listener, upstream_address).await });
    let worker = TcpStream::connect(proxy_address).await?;
    let (worker_read, mut worker_write) = worker.into_split();
    let mut worker_lines = BufReader::new(worker_read).lines();
    write_line(
        &mut worker_write,
        r#"{"id":1,"method":"mining.subscribe","params":[]}"#,
    )
    .await?;
    let _subscribed = worker_lines.next_line().await?;
    write_line(
        &mut worker_write,
        &format!(r#"{{"id":2,"method":"mining.authorize","params":["{username}","{secret}"]}}"#),
    )
    .await?;
    let _authorized = worker_lines.next_line().await?;
    let _difficulty = worker_lines.next_line().await?;
    let _notify = worker_lines.next_line().await?;
    let nonce = worked_nonce(
        "01020304",
        "00000001",
        StratumJobFields::new(
            "0000000000000000000000000000000000000000000000000000000000000000",
            "01000000",
            "00",
            "20000000",
            "207fffff",
            "5f5e1000",
        ),
        hex_target("3b9a8e6536000000000000000000000000000000000000000000000000000000")?,
    )?;

    // Act
    write_line(
        &mut worker_write,
        &format!(r#"{{"id":3,"method":"mining.submit","params":["{username}","job-upstream-first","00000001","5f5e1000","{nonce}"]}}"#),
    )
    .await?;
    timeout(Duration::from_secs(2), submitted_rx).await??;
    let worker_response = timeout(Duration::from_secs(2), worker_lines.next_line()).await??;
    let proxy_result = proxy_task.await?;

    // Assert
    assert!(worker_response.is_none());
    assert!(matches!(proxy_result, Err(StratumV1Error::Database(_))));
    upstream_task.await??;
    Ok(())
}

async fn upstream_until_submit(
    listener: TcpListener,
    username: String,
    secret: String,
    submitted: oneshot::Sender<()>,
) -> Result<(), std::io::Error> {
    let (stream, _) = listener.accept().await?;
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    let _subscribe = lines.next_line().await?;
    write_line(&mut write, r#"{"id":1,"result":[[["mining.notify","subscription-upstream-first"]],"01020304",4],"error":null}"#).await?;
    let authorize = lines.next_line().await?;
    if !authorize.is_some_and(|line| line.contains(&username) && line.contains(&secret)) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "authorization changed",
        ));
    }
    write_line(&mut write, r#"{"id":2,"result":true,"error":null}"#).await?;
    write_line(
        &mut write,
        r#"{"id":null,"method":"mining.set_difficulty","params":[0.000000001]}"#,
    )
    .await?;
    write_line(&mut write, r#"{"id":null,"method":"mining.notify","params":["job-upstream-first","0000000000000000000000000000000000000000000000000000000000000000","01000000","00",[],"20000000","207fffff","5f5e1000",true]}"#).await?;
    let _submit = lines.next_line().await?;
    let _ = submitted.send(());
    write_line(&mut write, r#"{"id":3,"result":true,"error":null}"#).await?;
    Ok(())
}
