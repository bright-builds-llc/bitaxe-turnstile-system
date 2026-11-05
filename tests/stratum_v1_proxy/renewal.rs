use std::{
    error::Error,
    time::{SystemTime, UNIX_EPOCH},
};

use bwg_core::{
    progress::WorkSessionId,
    stratum_v1::{
        PostgresAcceptedWorkOutbox, PostgresStratumSessionRegistry, StratumCredentialIssuer,
        StratumLeaseContext, StratumSessionCredentials, StratumSessionExtension, StratumTcpProxy,
        StratumV1Error,
    },
};
use tokio::{
    io::{AsyncBufReadExt as _, BufReader},
    net::{TcpListener, TcpStream},
    time::{Duration, sleep, timeout},
};

use super::{PostgresTestDatabase, fixtures::disconnect_sink, test_lease_context, write_line};

const SESSION_ID: &str = "session_stratum_renewal_01";

fn renewed_lease_context() -> Result<StratumLeaseContext, StratumV1Error> {
    StratumLeaseContext::new(
        "00000000-0000-4000-8000-000000000099".to_owned(),
        "boot_stratum_test".to_owned(),
        1_000,
        21_000,
        61_000,
    )
}

fn session_id() -> Result<WorkSessionId, Box<dyn Error>> {
    Ok(WorkSessionId::try_from(SESSION_ID.to_owned())?)
}

async fn registered(
    registry: &PostgresStratumSessionRegistry,
    now_unix_milliseconds: u64,
    expires_after_seconds: u64,
) -> Result<StratumSessionCredentials, Box<dyn Error>> {
    let now = now_unix_milliseconds / 1_000;
    let credentials = StratumCredentialIssuer::new([23_u8; 32]).issue_at_milliseconds(
        session_id()?,
        test_lease_context()?,
        now_unix_milliseconds,
        now + expires_after_seconds,
        now + 300,
    )?;
    registry.register(&credentials).await?;
    Ok(credentials)
}

fn extension(
    lease_context: StratumLeaseContext,
    now_unix_milliseconds: u64,
) -> Result<StratumSessionExtension, Box<dyn Error>> {
    let now = now_unix_milliseconds / 1_000;
    Ok(StratumSessionExtension::new(
        session_id()?,
        lease_context,
        now_unix_milliseconds,
        now + 60,
        now + 300,
    )?)
}

fn now_unix_milliseconds() -> Result<u64, Box<dyn Error>> {
    Ok(u64::try_from(
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis(),
    )?)
}

#[tokio::test]
async fn extension_keeps_the_secret_and_moves_the_lease_window() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let registry = PostgresStratumSessionRegistry::connect(database.database_url()).await?;
    let credentials = registered(&registry, 1_000_000, 10).await?;
    let renewed = extension(renewed_lease_context()?, 1_001_000)?;

    // Act
    registry.extend(&renewed, 1_001).await?;
    let replay = registry.extend(&renewed, 1_001).await;
    let authenticated = registry
        .authenticate(credentials.username(), credentials.secret(), 1_011)
        .await?
        .ok_or("the unchanged secret must authenticate past its first expiry")?;

    // Assert
    assert!(replay.is_ok());
    assert_eq!(authenticated.expires_at_unix_seconds(), 1_061);
    assert_eq!(authenticated.lease_context(), &renewed_lease_context()?);
    Ok(())
}

#[tokio::test]
async fn extension_under_another_lease_is_refused() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let registry = PostgresStratumSessionRegistry::connect(database.database_url()).await?;
    registered(&registry, 1_000_000, 10).await?;
    let other_lease = StratumLeaseContext::new(
        "00000000-0000-4000-8000-000000000097".to_owned(),
        "boot_stratum_test".to_owned(),
        1_000,
        21_000,
        61_000,
    )?;

    // Act
    let result = registry
        .extend(&extension(other_lease, 1_001_000)?, 1_001)
        .await;

    // Assert
    assert!(matches!(result, Err(StratumV1Error::UnextendableSession)));
    Ok(())
}

#[tokio::test]
async fn older_extension_cannot_roll_back_a_newer_one() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let registry = PostgresStratumSessionRegistry::connect(database.database_url()).await?;
    registered(&registry, 1_000_000, 10).await?;
    let older = extension(renewed_lease_context()?, 1_001_000)?;
    let newer_context = StratumLeaseContext::new(
        "00000000-0000-4000-8000-000000000099".to_owned(),
        "boot_stratum_test".to_owned(),
        2_000,
        22_000,
        62_000,
    )?;
    registry
        .extend(&extension(newer_context, 1_002_000)?, 1_002)
        .await?;

    // Act
    let result = registry.extend(&older, 1_002).await;

    // Assert
    assert!(matches!(result, Err(StratumV1Error::UnextendableSession)));
    Ok(())
}

#[tokio::test]
async fn expired_session_cannot_be_extended() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let registry = PostgresStratumSessionRegistry::connect(database.database_url()).await?;
    registered(&registry, 1_000_000, 10).await?;

    // Act
    let result = registry
        .extend(&extension(renewed_lease_context()?, 1_010_000)?, 1_010)
        .await;

    // Assert
    assert!(matches!(result, Err(StratumV1Error::UnextendableSession)));
    Ok(())
}

#[tokio::test]
async fn live_connection_outlives_its_admitted_expiry_after_an_extension()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let outbox = PostgresAcceptedWorkOutbox::connect(database.database_url()).await?;
    let registry = PostgresStratumSessionRegistry::connect(database.database_url()).await?;
    let admitted_at = now_unix_milliseconds()?;
    // Two seconds leave at least one whole second to extend before the admitted expiry.
    let credentials = registered(&registry, admitted_at, 2).await?;
    let upstream_listener = TcpListener::bind("127.0.0.1:0").await?;
    let upstream_address = upstream_listener.local_addr()?;
    let upstream_task = tokio::spawn(upstream_echoing_one_request(upstream_listener));
    let proxy = StratumTcpProxy::new(outbox, registry.clone(), disconnect_sink());
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
        &format!(
            r#"{{"id":2,"method":"mining.authorize","params":["{}","{}"]}}"#,
            credentials.username(),
            credentials.secret()
        ),
    )
    .await?;
    let _authorized = worker_lines.next_line().await?;
    let extended_at = now_unix_milliseconds()?;
    registry
        .extend(
            &extension(renewed_lease_context()?, extended_at)?,
            extended_at / 1_000,
        )
        .await?;
    let admitted_expiry_milliseconds = credentials.expires_at_unix_seconds() * 1_000;
    sleep(Duration::from_millis(
        admitted_expiry_milliseconds.saturating_sub(now_unix_milliseconds()?) + 200,
    ))
    .await;

    // Act
    write_line(
        &mut worker_write,
        r#"{"id":3,"method":"mining.extranonce.subscribe","params":[]}"#,
    )
    .await?;
    let response = timeout(Duration::from_secs(2), worker_lines.next_line()).await??;

    // Assert
    assert_eq!(
        response.as_deref(),
        Some(r#"{"id":3,"result":true,"error":null}"#)
    );
    drop(worker_write);
    drop(worker_lines);
    proxy_task.await??;
    upstream_task.await??;
    Ok(())
}

async fn upstream_echoing_one_request(listener: TcpListener) -> Result<(), std::io::Error> {
    let (stream, _) = listener.accept().await?;
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    let _subscribe = lines.next_line().await?;
    write_line(
        &mut write,
        r#"{"id":1,"result":[[["mining.notify","renewal"]],"0a0b0c0d",4],"error":null}"#,
    )
    .await?;
    let _authorize = lines.next_line().await?;
    write_line(&mut write, r#"{"id":2,"result":true,"error":null}"#).await?;
    let _request = lines.next_line().await?;
    write_line(&mut write, r#"{"id":3,"result":true,"error":null}"#).await?;
    let _closed = lines.next_line().await?;
    Ok(())
}
