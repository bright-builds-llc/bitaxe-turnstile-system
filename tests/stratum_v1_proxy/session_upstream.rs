use std::{
    error::Error,
    time::{SystemTime, UNIX_EPOCH},
};

use bwg_core::{
    challenge::ChallengeId,
    pool_offer::PoolSelection,
    progress::WorkSessionId,
    stratum_v1::{
        PostgresAcceptedWorkOutbox, PostgresStratumSessionRegistry, StratumCredentialIssuer,
        StratumSessionCredentials, StratumTcpProxy, StratumV1Error,
    },
};
use tokio::{
    io::{AsyncBufReadExt as _, BufReader},
    net::{TcpListener, TcpStream},
    sync::oneshot,
};

use super::{PostgresTestDatabase, fixtures::disconnect_sink, test_lease_context, write_line};

const PAYOUT_ADDRESS: &str = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";

struct Proxied {
    proxy_result: Result<(), StratumV1Error>,
    maybe_upstream_authorize: Option<String>,
}

async fn registered(
    registry: &PostgresStratumSessionRegistry,
    session_id: &WorkSessionId,
) -> Result<StratumSessionCredentials, Box<dyn Error>> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let credentials = StratumCredentialIssuer::new([29_u8; 32]).issue(
        session_id.clone(),
        test_lease_context()?,
        now,
        now + 60,
        now + 300,
    )?;
    registry.register(&credentials).await?;
    Ok(credentials)
}

/// Admits one Worker through a per-session proxy and reports what the pool was told.
async fn admit(
    database: &PostgresTestDatabase,
    registry: PostgresStratumSessionRegistry,
    credentials: &StratumSessionCredentials,
) -> Result<Proxied, Box<dyn Error>> {
    let outbox = PostgresAcceptedWorkOutbox::connect(database.database_url()).await?;
    let proxy = StratumTcpProxy::new(outbox, registry, disconnect_sink())
        .with_session_upstream_authorization("x".to_owned())?;
    let upstream_listener = TcpListener::bind("127.0.0.1:0").await?;
    let upstream_address = upstream_listener.local_addr()?;
    let (authorize_tx, authorize_rx) = oneshot::channel();
    let upstream_task = tokio::spawn(async move {
        let (stream, _) = upstream_listener.accept().await?;
        let (read, mut write) = stream.into_split();
        let mut lines = BufReader::new(read).lines();
        let _subscribe = lines.next_line().await?;
        write_line(
            &mut write,
            r#"{"id":1,"result":[[["mining.notify","per-session"]],"0e0f1011",4],"error":null}"#,
        )
        .await?;
        if let Some(authorize) = lines.next_line().await? {
            let _ = authorize_tx.send(authorize);
            write_line(&mut write, r#"{"id":2,"result":true,"error":null}"#).await?;
        }
        while lines.next_line().await?.is_some() {}
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
        &format!(
            r#"{{"id":2,"method":"mining.authorize","params":["{}","{}"]}}"#,
            credentials.username(),
            credentials.secret()
        ),
    )
    .await?;
    let _authorized = worker_lines.next_line().await?;
    drop(worker_write);
    drop(worker_lines);
    let proxy_result = proxy_task.await?;
    upstream_task.await??;
    Ok(Proxied {
        proxy_result,
        maybe_upstream_authorize: authorize_rx.await.ok(),
    })
}

#[tokio::test]
async fn pool_is_authorized_with_the_sessions_stored_payout_choice() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let registry = PostgresStratumSessionRegistry::connect(database.database_url()).await?;
    let session_id = WorkSessionId::try_from("session_per_session_upstream_01".to_owned())?;
    let challenge_id = ChallengeId::try_from("challenge_persessionupstream01".to_owned())?;
    let credentials = registered(&registry, &session_id).await?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let selection = PoolSelection::bitcoin_address(
        "pool_offer_hydra_solo_v1".to_owned(),
        PAYOUT_ADDRESS.to_owned(),
    )?;
    registry
        .record_pool_selection(&session_id, &challenge_id, &selection, now + 300, now)
        .await?;

    // Act
    let proxied = admit(&database, registry, &credentials).await?;

    // Assert
    let authorize = proxied
        .maybe_upstream_authorize
        .ok_or("the pool must see an authorize")?;
    assert!(proxied.proxy_result.is_ok());
    assert!(authorize.contains(PAYOUT_ADDRESS));
    assert!(!authorize.contains(credentials.username()));
    Ok(())
}

#[tokio::test]
async fn session_without_a_stored_choice_is_refused() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let registry = PostgresStratumSessionRegistry::connect(database.database_url()).await?;
    let session_id = WorkSessionId::try_from("session_per_session_upstream_02".to_owned())?;
    let credentials = registered(&registry, &session_id).await?;

    // Act
    let proxied = admit(&database, registry, &credentials).await?;

    // Assert
    assert!(matches!(
        proxied.proxy_result,
        Err(StratumV1Error::UnknownSession)
    ));
    assert!(proxied.maybe_upstream_authorize.is_none());
    Ok(())
}
