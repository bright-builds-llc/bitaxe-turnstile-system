//! A Worker such as ESP-Miner submits in-flight results for jobs a new Bitcoin tip
//! or a reconnect has retired. Pools answer those with error 21 and keep the
//! connection, and so does the proxy. A job this session dropped is "Stale job";
//! one it never sent is "Job not found".

use bwg_core::stratum_v1::UnheldJob;

use super::fixtures::{StratumJobFields, disconnect_sink, worked_nonce};
use super::*;

const PREVIOUS_BLOCK: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const JOB_NOT_FOUND: &str = r#"{"id":4,"result":null,"error":[21,"Job not found",null]}"#;
const STALE_JOB: &str = r#"{"id":4,"result":null,"error":[21,"Stale job",null]}"#;
/// 96 retained jobs plus 192 remembered drops, plus one more to push out the first.
const JOBS_PAST_EVERY_BOUND: usize = 96 + 192 + 1;

fn refused(reason: UnheldJob, response: &str) -> Vec<StratumProxyAction> {
    vec![StratumProxyAction::RefuseSubmit {
        reason,
        worker_response: response.to_owned(),
    }]
}

fn notify(job_id: &str, clean_jobs: bool) -> String {
    format!(
        r#"{{"id":null,"method":"mining.notify","params":["{job_id}","{PREVIOUS_BLOCK}","01000000","00",[],"20000000","1d00ffff","5f5e1000",{clean_jobs}]}}"#
    )
}

fn submit(id: u64, job_id: &str, nonce: &str) -> String {
    format!(
        r#"{{"id":{id},"method":"mining.submit","params":["bwg-session-stale","{job_id}","00000001","5f5e1000","{nonce}"]}}"#
    )
}

#[test]
fn clean_notify_answers_a_submit_for_the_superseded_job_as_stale() -> Result<(), Box<dyn Error>> {
    // Arrange
    let mut session = authorized_session()?;
    session.upstream_frame(&notify("job-old", true), 1_000)?;
    session.upstream_frame(&notify("job-current", true), 1_001)?;

    // Act
    let actions = session.worker_frame(&submit(4, "job-old", "abcdef01"), 1_002)?;

    // Assert
    assert_eq!(actions, refused(UnheldJob::Stale, STALE_JOB));
    Ok(())
}

#[test]
fn a_job_never_sent_to_the_session_is_not_found() -> Result<(), Box<dyn Error>> {
    // Arrange
    let mut session = authorized_session()?;
    session.upstream_frame(&notify("job-current", true), 1_000)?;

    // Act
    let actions = session.worker_frame(&submit(4, "job-elsewhere", "abcdef01"), 1_000)?;

    // Assert
    assert_eq!(actions, refused(UnheldJob::Unknown, JOB_NOT_FOUND));
    Ok(())
}

#[test]
fn remembered_drops_are_bounded_oldest_first() -> Result<(), Box<dyn Error>> {
    // Arrange
    let mut session = authorized_session()?;
    for id in 0..JOBS_PAST_EVERY_BOUND {
        session.upstream_frame(&notify(&format!("job-{id}"), false), 1_000)?;
    }

    // Act
    let forgotten = session.worker_frame(&submit(4, "job-0", "00000000"), 1_000)?;
    let remembered = session.worker_frame(&submit(4, "job-1", "00000000"), 1_000)?;

    // Assert
    assert_eq!(forgotten, refused(UnheldJob::Unknown, JOB_NOT_FOUND));
    assert_eq!(remembered, refused(UnheldJob::Stale, STALE_JOB));
    Ok(())
}

#[test]
fn a_stale_submit_leaves_no_outstanding_request() -> Result<(), Box<dyn Error>> {
    // Arrange
    let mut session = authorized_session()?;
    session.upstream_frame(&notify("job-current", true), 1_000)?;
    session.worker_frame(&submit(4, "job-retired", "00000000"), 1_000)?;

    // Act
    let actions = session.worker_frame(&submit(4, "job-current", "00000000"), 1_000)?;

    // Assert
    assert!(matches!(
        actions.as_slice(),
        [StratumProxyAction::ForwardUpstream(_)]
    ));
    Ok(())
}

#[test]
fn the_oldest_job_is_retired_once_the_retention_bound_is_reached() -> Result<(), Box<dyn Error>> {
    // Arrange
    let mut session = authorized_session()?;
    for id in 0..=96 {
        session.upstream_frame(&notify(&format!("job-{id}"), false), 1_000)?;
    }

    // Act
    let oldest = session.worker_frame(&submit(4, "job-0", "00000000"), 1_000)?;
    let next_oldest = session.worker_frame(&submit(5, "job-1", "00000000"), 1_000)?;

    // Assert
    assert_eq!(oldest, refused(UnheldJob::Stale, STALE_JOB));
    assert!(matches!(
        next_oldest.as_slice(),
        [StratumProxyAction::ForwardUpstream(_)]
    ));
    Ok(())
}

/// Answers like Hydra after a reconnect and records every frame it receives.
async fn current_tip_upstream(listener: TcpListener) -> Result<Vec<String>, std::io::Error> {
    let (stream, _) = listener.accept().await?;
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    let mut received = Vec::new();
    for reply in [
        r#"{"id":1,"result":[[["mining.notify","current"]],"01020304",4],"error":null}"#,
        r#"{"id":2,"result":true,"error":null}"#,
    ] {
        received.extend(lines.next_line().await?);
        write_line(&mut write, reply).await?;
    }
    write_line(
        &mut write,
        r#"{"id":null,"method":"mining.set_difficulty","params":[0.000000001]}"#,
    )
    .await?;
    write_line(&mut write, &notify("job-current", true)).await?;
    while let Some(line) = lines.next_line().await? {
        let maybe_id = serde_json::from_str::<Value>(&line)?
            .get("id")
            .and_then(Value::as_u64);
        received.push(line);
        if let Some(id) = maybe_id {
            write_line(
                &mut write,
                &format!(r#"{{"id":{id},"result":true,"error":null}}"#),
            )
            .await?;
        }
    }
    Ok(received)
}

#[tokio::test]
async fn a_pre_tip_result_is_answered_locally_and_mining_continues() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let outbox = PostgresAcceptedWorkOutbox::connect(database.database_url()).await?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let session_id = WorkSessionId::try_from("session_stratum_pre_tip_01".to_owned())?;
    let credentials = StratumCredentialIssuer::new([12_u8; 32]).issue(
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
    let upstream_task = tokio::spawn(current_tip_upstream(upstream_listener));
    let proxy = StratumTcpProxy::new(outbox.clone(), registry, disconnect_sink());
    let proxy_listener = TcpListener::bind("127.0.0.1:0").await?;
    let proxy_address = proxy_listener.local_addr()?;
    let proxy_task =
        tokio::spawn(async move { proxy.serve_one(&proxy_listener, upstream_address).await });
    let (worker_read, mut worker_write) = TcpStream::connect(proxy_address).await?.into_split();
    let mut worker_lines = BufReader::new(worker_read).lines();
    let nonce = worked_nonce(
        "01020304",
        "00000001",
        StratumJobFields::new(
            PREVIOUS_BLOCK,
            "01000000",
            "00",
            "20000000",
            "1d00ffff",
            "5f5e1000",
        ),
        hex_target("3b9a8e6536000000000000000000000000000000000000000000000000000000")?,
    )?;
    for frame in [
        r#"{"id":1,"method":"mining.subscribe","params":["bitaxe/BM1370"]}"#.to_owned(),
        format!(r#"{{"id":2,"method":"mining.authorize","params":["{username}","{secret}"]}}"#),
    ] {
        write_line(&mut worker_write, &frame).await?;
    }
    for _ in 0..4 {
        worker_lines.next_line().await?;
    }

    // Act
    write_line(
        &mut worker_write,
        &submit(4, "job-pre-tip", &nonce).replace("bwg-session-stale", username),
    )
    .await?;
    let maybe_stale_reply = worker_lines.next_line().await?;
    write_line(
        &mut worker_write,
        &submit(5, "job-current", &nonce).replace("bwg-session-stale", username),
    )
    .await?;
    let maybe_accepted = worker_lines.next_line().await?;
    let maybe_claimed = outbox
        .claim_next("delivery_worker_pre_tip", now, now + 30)
        .await?;
    drop(worker_lines);
    drop(worker_write);
    let proxy_result = proxy_task.await?;
    let upstream_received = upstream_task.await??;

    // Assert
    assert!(proxy_result.is_ok(), "proxy ended with {proxy_result:?}");
    assert_eq!(maybe_stale_reply.as_deref(), Some(JOB_NOT_FOUND));
    assert_eq!(
        maybe_accepted.as_deref(),
        Some(r#"{"id":5,"result":true,"error":null}"#)
    );
    assert!(
        !upstream_received
            .iter()
            .any(|frame| frame.contains("job-pre-tip"))
    );
    let claimed = maybe_claimed.ok_or("the current-job share must be credited")?;
    assert_eq!(claimed.event().work_session_id(), &session_id);
    Ok(())
}
