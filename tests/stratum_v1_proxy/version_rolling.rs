//! The board's C firmware, like stock ESP-Miner, opens with `mining.configure` for
//! version rolling, then sends subscribe and authorize back to back, and submits
//! with a sixth version-bits parameter.

use super::fixtures::{StratumJobFields, disconnect_sink, worked_nonce_only_for};
use super::*;

const PREVIOUS_BLOCK: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const JOB_VERSION: &str = "20000000";
const ROLLED_VERSION: &str = "2000e000";
const VERSION_BITS: &str = "0000e000";
const CONFIGURE_REPLY: &str =
    r#"{"id":1,"result":{"version-rolling":true,"version-rolling.mask":"1fffe000"},"error":null}"#;

fn job(version: &str) -> StratumJobFields<'_> {
    StratumJobFields::new(
        PREVIOUS_BLOCK,
        "01000000",
        "00",
        version,
        "1d00ffff",
        "5f5e1000",
    )
}

/// Answers like Hydra with `version_mask = "1fffe000"` and records the submit it sees.
async fn version_rolling_upstream(listener: TcpListener) -> Result<Vec<String>, std::io::Error> {
    let (stream, _) = listener.accept().await?;
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    let mut received = Vec::new();
    for reply in [
        CONFIGURE_REPLY,
        r#"{"id":2,"result":[[["mining.notify","rolling"]],"01020304",4],"error":null}"#,
        r#"{"id":3,"result":true,"error":null}"#,
    ] {
        received.extend(lines.next_line().await?);
        write_line(&mut write, reply).await?;
    }
    write_line(
        &mut write,
        r#"{"id":null,"method":"mining.set_difficulty","params":[0.000000001]}"#,
    )
    .await?;
    write_line(
        &mut write,
        &format!(
            r#"{{"id":null,"method":"mining.notify","params":["job-rolling","{PREVIOUS_BLOCK}","01000000","00",[],"{JOB_VERSION}","1d00ffff","5f5e1000",true]}}"#
        ),
    )
    .await?;
    received.extend(lines.next_line().await?);
    write_line(&mut write, r#"{"id":4,"result":true,"error":null}"#).await?;
    while lines.next_line().await?.is_some() {}
    Ok(received)
}

#[tokio::test]
async fn board_handshake_with_version_rolling_is_admitted_and_credited()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let outbox = PostgresAcceptedWorkOutbox::connect(database.database_url()).await?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let session_id = WorkSessionId::try_from("session_stratum_rolling_01".to_owned())?;
    let credentials = StratumCredentialIssuer::new([11_u8; 32]).issue(
        session_id.clone(),
        test_lease_context()?,
        now,
        now + 60,
        now + 300,
    )?;
    let (username, secret) = (credentials.username(), credentials.secret());
    let registry = PostgresStratumSessionRegistry::connect(database.database_url()).await?;
    registry.register(&credentials).await?;
    let upstream_listener = TcpListener::bind("127.0.0.1:0").await?;
    let upstream_address = upstream_listener.local_addr()?;
    let upstream_task = tokio::spawn(version_rolling_upstream(upstream_listener));
    let proxy = StratumTcpProxy::new(outbox.clone(), registry, disconnect_sink());
    let proxy_listener = TcpListener::bind("127.0.0.1:0").await?;
    let proxy_address = proxy_listener.local_addr()?;
    let proxy_task =
        tokio::spawn(async move { proxy.serve_one(&proxy_listener, upstream_address).await });
    let (worker_read, mut worker_write) = TcpStream::connect(proxy_address).await?.into_split();
    let mut worker_lines = BufReader::new(worker_read).lines();
    let nonce = worked_nonce_only_for(
        "01020304",
        "00000001",
        job(ROLLED_VERSION),
        job(JOB_VERSION),
        hex_target("3b9a8e6536000000000000000000000000000000000000000000000000000000")?,
    )?;

    // Act
    for frame in [
        r#"{"id":1,"method":"mining.configure","params":[["version-rolling"],{"version-rolling.mask":"ffffffff"}]}"#.to_owned(),
        r#"{"id":2,"method":"mining.subscribe","params":["bitaxe/BM1370"]}"#.to_owned(),
        format!(r#"{{"id":3,"method":"mining.authorize","params":["{username}","{secret}"]}}"#),
    ] {
        write_line(&mut worker_write, &frame).await?;
    }
    let mut handshake = Vec::new();
    for _ in 0..5 {
        handshake.extend(worker_lines.next_line().await?);
    }
    write_line(
        &mut worker_write,
        &format!(
            r#"{{"id":4,"method":"mining.submit","params":["{username}","job-rolling","00000001","5f5e1000","{nonce}","{VERSION_BITS}"]}}"#
        ),
    )
    .await?;
    let maybe_accepted = worker_lines.next_line().await?;
    let maybe_claimed = outbox
        .claim_next("delivery_worker_rolling", now, now + 30)
        .await?;
    drop(worker_lines);
    drop(worker_write);
    let proxy_result = proxy_task.await?;
    let upstream_received = upstream_task.await??;

    // Assert
    assert!(proxy_result.is_ok(), "proxy ended with {proxy_result:?}");
    assert_eq!(handshake.first().map(String::as_str), Some(CONFIGURE_REPLY));
    assert!(upstream_received[0].contains("mining.configure"));
    assert!(upstream_received[3].ends_with(&format!(r#""{VERSION_BITS}"]}}"#)));
    assert_eq!(
        maybe_accepted.as_deref(),
        Some(r#"{"id":4,"result":true,"error":null}"#)
    );
    let claimed = maybe_claimed.ok_or("the version-rolled share must be credited")?;
    assert_eq!(claimed.event().work_session_id(), &session_id);
    Ok(())
}

#[test]
fn version_bits_without_a_negotiated_mask_are_refused() -> Result<(), Box<dyn Error>> {
    // Arrange
    let mut session = authorized_session()?;
    session.upstream_frame(
        &format!(
            r#"{{"id":null,"method":"mining.notify","params":["job-unrolled","{PREVIOUS_BLOCK}","01000000","00",[],"{JOB_VERSION}","1d00ffff","5f5e1000",true]}}"#
        ),
        1_000,
    )?;

    // Act
    let result = session.worker_frame(
        &format!(
            r#"{{"id":9,"method":"mining.submit","params":["bwg-session-stale","job-unrolled","00000001","5f5e1000","00000000","{VERSION_BITS}"]}}"#
        ),
        1_000,
    );

    // Assert
    assert!(matches!(
        result,
        Err(StratumV1Error::VersionRollingNotNegotiated)
    ));
    Ok(())
}

#[test]
fn configure_reply_sets_the_mask_a_rolled_submit_needs() -> Result<(), Box<dyn Error>> {
    // Arrange
    let mut session = authorized_session()?;
    session.worker_frame(
        r#"{"id":7,"method":"mining.configure","params":[["version-rolling"],{"version-rolling.mask":"ffffffff"}]}"#,
        1_000,
    )?;
    session.upstream_frame(
        r#"{"id":7,"result":{"version-rolling":true,"version-rolling.mask":"1fffe000"},"error":null}"#,
        1_000,
    )?;
    session.upstream_frame(
        &format!(
            r#"{{"id":null,"method":"mining.notify","params":["job-rolled","{PREVIOUS_BLOCK}","01000000","00",[],"{JOB_VERSION}","1d00ffff","5f5e1000",true]}}"#
        ),
        1_000,
    )?;

    // Act
    let actions = session.worker_frame(
        &format!(
            r#"{{"id":9,"method":"mining.submit","params":["bwg-session-stale","job-rolled","00000001","5f5e1000","00000000","{VERSION_BITS}"]}}"#
        ),
        1_000,
    )?;

    // Assert
    assert!(matches!(
        actions.as_slice(),
        [StratumProxyAction::ForwardUpstream(_)]
    ));
    Ok(())
}

#[tokio::test]
async fn configure_does_not_open_the_session_to_other_requests() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let outbox = PostgresAcceptedWorkOutbox::connect(database.database_url()).await?;
    let registry = PostgresStratumSessionRegistry::connect(database.database_url()).await?;
    let upstream_listener = TcpListener::bind("127.0.0.1:0").await?;
    let upstream_address = upstream_listener.local_addr()?;
    let upstream_task = tokio::spawn(async move {
        let (stream, _) = upstream_listener.accept().await?;
        let (read, mut write) = stream.into_split();
        let mut lines = BufReader::new(read).lines();
        let mut received = Vec::new();
        received.extend(lines.next_line().await?);
        write_line(&mut write, CONFIGURE_REPLY).await?;
        while let Some(line) = lines.next_line().await? {
            received.push(line);
        }
        Ok::<_, std::io::Error>(received)
    });
    let proxy = StratumTcpProxy::new(outbox, registry, disconnect_sink());
    let proxy_listener = TcpListener::bind("127.0.0.1:0").await?;
    let proxy_address = proxy_listener.local_addr()?;
    let proxy_task =
        tokio::spawn(async move { proxy.serve_one(&proxy_listener, upstream_address).await });
    let (_worker_read, mut worker_write) = TcpStream::connect(proxy_address).await?.into_split();

    // Act
    write_line(
        &mut worker_write,
        r#"{"id":1,"method":"mining.configure","params":[["version-rolling"],{"version-rolling.mask":"ffffffff"}]}"#,
    )
    .await?;
    write_line(
        &mut worker_write,
        r#"{"id":2,"method":"mining.suggest_difficulty","params":[1000]}"#,
    )
    .await?;
    let proxy_result = proxy_task.await?;
    let upstream_received = upstream_task.await??;

    // Assert
    assert!(matches!(
        proxy_result,
        Err(StratumV1Error::AuthorizationRequired)
    ));
    assert_eq!(upstream_received.len(), 1);
    Ok(())
}
