use std::{error::Error, time::Duration};

use bwg_core::{
    progress::WorkSessionId,
    stratum_v1::{
        PostgresAcceptedWorkOutbox, PostgresStratumSessionRegistry, StratumSession,
        StratumSessionConfig, StratumTcpProxy, StratumV1Error,
    },
};
use tokio::{
    net::{TcpListener, TcpStream},
    time::timeout,
};

use super::{PostgresTestDatabase, test_lease_context};

#[test]
fn session_rejects_oversized_frames_and_unbounded_request_or_job_state()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let mut oversized = bounded_session("session_stratum_bound_frame")?;
    let mut requests = bounded_session("session_stratum_bound_requests")?;
    let mut jobs = bounded_session("session_stratum_bound_jobs")?;
    let oversized_frame = format!(
        r#"{{"id":1,"method":"mining.configure","params":["{}"]}}"#,
        "x".repeat(20_000)
    );
    jobs.upstream_frame(
        r#"{"id":null,"method":"mining.set_difficulty","params":[1]}"#,
        1_000,
    )?;
    for id in 0..64 {
        requests.worker_frame(
            &format!(r#"{{"id":{id},"method":"mining.configure","params":[]}}"#),
            1_000,
        )?;
        jobs.upstream_frame(
            &format!(r#"{{"id":null,"method":"mining.notify","params":["job-{id}","0000000000000000000000000000000000000000000000000000000000000000","01000000","00",[],"20000000","1d00ffff","5f5e1000",false]}}"#),
            1_000,
        )?;
    }

    // Act
    let frame_result = oversized.worker_frame(&oversized_frame, 1_000);
    let request_result = requests.worker_frame(
        r#"{"id":64,"method":"mining.configure","params":[]}"#,
        1_000,
    );
    let job_result = jobs.upstream_frame(
        r#"{"id":null,"method":"mining.notify","params":["job-64","0000000000000000000000000000000000000000000000000000000000000000","01000000","00",[],"20000000","1d00ffff","5f5e1000",false]}"#,
        1_000,
    );

    // Assert
    assert!(matches!(frame_result, Err(StratumV1Error::FrameTooLarge)));
    assert!(matches!(
        request_result,
        Err(StratumV1Error::CapacityExceeded)
    ));
    assert!(matches!(job_result, Err(StratumV1Error::CapacityExceeded)));
    Ok(())
}

#[tokio::test]
async fn idle_tcp_connection_terminates_at_the_configured_deadline() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let outbox = PostgresAcceptedWorkOutbox::connect(database.database_url()).await?;
    let sessions = PostgresStratumSessionRegistry::connect(database.database_url()).await?;
    let proxy = StratumTcpProxy::with_idle_timeout(outbox, sessions, Duration::from_millis(20))?;
    let upstream_listener = TcpListener::bind("127.0.0.1:0").await?;
    let upstream_address = upstream_listener.local_addr()?;
    let upstream_task = tokio::spawn(async move {
        let (_stream, _) = upstream_listener.accept().await?;
        tokio::time::sleep(Duration::from_secs(1)).await;
        Ok::<(), std::io::Error>(())
    });
    let proxy_listener = TcpListener::bind("127.0.0.1:0").await?;
    let proxy_address = proxy_listener.local_addr()?;
    let proxy_task =
        tokio::spawn(async move { proxy.serve_one(&proxy_listener, upstream_address).await });
    let _worker = TcpStream::connect(proxy_address).await?;

    // Act
    let result = timeout(Duration::from_secs(1), proxy_task).await??;

    // Assert
    assert!(matches!(result, Err(StratumV1Error::IdleTimeout)));
    upstream_task.abort();
    Ok(())
}

fn bounded_session(session_id: &str) -> Result<StratumSession, Box<dyn Error>> {
    Ok(StratumSession::new(StratumSessionConfig::new(
        WorkSessionId::try_from(session_id.to_owned())?,
        test_lease_context()?,
        "bwg-bounded-session".to_owned(),
        "bounded-session-secret".to_owned(),
        1_000,
        1_060,
        2_000,
    )?)?)
}
