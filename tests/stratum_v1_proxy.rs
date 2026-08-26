use std::{
    error::Error,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use bwg_core::{
    progress::{
        AcceptedWorkEvent, AcceptedWorkEventId, AcceptedWorkEventInput, NetworkTargetOutcome,
        ReceiptTime, ShareFingerprint, WorkSessionId,
    },
    stratum_v1::{
        AcceptedWorkDeliveryWorker, AcceptedWorkSink, AcceptedWorkSinkError, DeliveryOutcome,
        ExtranonceSpace, PoolAdapterRetentionCounts, PostgresAcceptedWorkOutbox,
        PostgresPoolAdapterRetention, PostgresStratumSessionRegistry, StratumCredentialIssuer,
        StratumLeaseContext, StratumProxyAction, StratumSession, StratumSessionConfig,
        StratumTcpProxy, StratumV1Error,
    },
};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader},
    net::{TcpListener, TcpStream},
};

#[path = "support/postgres.rs"]
mod postgres_support;
use postgres_support::PostgresTestDatabase;
#[path = "stratum_v1_proxy/authority_delivery.rs"]
mod authority_delivery;
#[path = "stratum_v1_proxy/bounds.rs"]
mod bounds;
#[path = "stratum_v1_proxy/credentials.rs"]
mod credentials;
#[path = "stratum_v1_proxy/fixtures.rs"]
mod fixtures;
#[path = "support/stratum_hash.rs"]
mod stratum_hash_support;
use fixtures::{StratumJobFields, hex_target, test_lease_context, worked_nonce};
#[path = "stratum_v1_proxy/persistence.rs"]
mod persistence;
#[path = "stratum_v1_proxy/retention.rs"]
mod retention;
#[path = "stratum_v1_proxy/target_math.rs"]
mod target_math;
#[path = "stratum_v1_proxy/upstream_first.rs"]
mod upstream_first;

#[test]
fn standard_transcript_persists_an_accepted_submit_before_worker_acknowledgement()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let vector = serde_json::from_str::<Value>(include_str!(
        "../conformance/bwg-0.1/stratum-v1-proxy-transcript.json"
    ))?;
    let session_id = WorkSessionId::try_from(required_vector(&vector, "session_id")?.to_owned())?;
    let expected_session_id = session_id.clone();
    let mut session = StratumSession::new(StratumSessionConfig::new(
        session_id,
        test_lease_context()?,
        required_vector(&vector, "username")?.to_owned(),
        required_vector(&vector, "secret")?.to_owned(),
        1_000,
        1_060,
        2_000,
    )?)?;
    let subscribe = required_vector(&vector, "subscribe")?;
    let subscribed = required_vector(&vector, "subscribed")?;
    let authorize = required_vector(&vector, "authorize")?;
    let authorized = required_vector(&vector, "authorized")?;
    let difficulty = required_vector(&vector, "difficulty")?;
    let notify = required_vector(&vector, "notify")?;
    let submit = required_vector(&vector, "submit")?;
    let accepted = required_vector(&vector, "accepted")?;

    // Act
    assert_eq!(
        session.worker_frame(subscribe, 1_000)?,
        [StratumProxyAction::ForwardUpstream(subscribe.to_owned())]
    );
    let subscribe_actions = session.upstream_frame(subscribed, 1_000)?;
    let [
        StratumProxyAction::ReserveExtranonce {
            token,
            session_id,
            extranonce1,
        },
    ] = subscribe_actions.as_slice()
    else {
        return Err("subscribe response must reserve unique extranonce space".into());
    };
    let mut extranonces = ExtranonceSpace::default();
    extranonces.reserve(session_id, extranonce1)?;
    assert_eq!(
        session.extranonce_reserved(token)?,
        StratumProxyAction::ForwardWorker(subscribed.to_owned())
    );
    assert_eq!(
        session.worker_frame(authorize, 1_000)?,
        [StratumProxyAction::ForwardUpstream(authorize.to_owned())]
    );
    assert_eq!(
        session.upstream_frame(authorized, 1_000)?,
        [StratumProxyAction::ForwardWorker(authorized.to_owned())]
    );
    assert_eq!(
        session.upstream_frame(difficulty, 1_000)?,
        [StratumProxyAction::ForwardWorker(difficulty.to_owned())]
    );
    assert_eq!(
        session.upstream_frame(notify, 1_000)?,
        [StratumProxyAction::ForwardWorker(notify.to_owned())]
    );
    assert_eq!(
        session.worker_frame(submit, 1_001)?,
        [StratumProxyAction::ForwardUpstream(submit.to_owned())]
    );
    let accepted_actions = session.upstream_frame(accepted, 1_002)?;
    let [StratumProxyAction::PersistAccepted { token, event, .. }] = accepted_actions.as_slice()
    else {
        return Err("accepted response must wait for durable event persistence".into());
    };

    // Assert
    assert_eq!(event.work_session_id(), &expected_session_id);
    assert_eq!(
        event.assigned_target_be_bytes(),
        hex_target(required_vector(&vector, "assigned_target_hex")?)?
    );
    assert_eq!(
        session.accepted_persisted(token)?,
        StratumProxyAction::ForwardWorker(accepted.to_owned())
    );
    Ok(())
}

fn required_vector<'a>(vector: &'a Value, field: &str) -> Result<&'a str, Box<dyn Error>> {
    vector[field]
        .as_str()
        .ok_or_else(|| format!("Stratum conformance vector needs {field}").into())
}

#[test]
fn two_sessions_cannot_share_the_same_extranonce_space() -> Result<(), Box<dyn Error>> {
    // Arrange
    let first = WorkSessionId::try_from("session_stratum_extranonce_01".to_owned())?;
    let second = WorkSessionId::try_from("session_stratum_extranonce_02".to_owned())?;
    let mut extranonces = ExtranonceSpace::default();
    extranonces.reserve(&first, "aAbB")?;

    // Act
    let replay = extranonces.reserve(&first, "aabb");
    let collision = extranonces.reserve(&second, "AABB");
    let distinct = extranonces.reserve(&second, "05060708");

    // Assert
    assert!(replay.is_ok());
    assert!(matches!(
        collision,
        Err(StratumV1Error::ExtranonceCollision)
    ));
    assert!(distinct.is_ok());
    Ok(())
}

#[test]
fn accepted_event_keeps_the_target_bound_to_its_job() -> Result<(), Box<dyn Error>> {
    // Arrange
    let mut session = authorized_session()?;
    session.upstream_frame(
        r#"{"id":null,"method":"mining.set_difficulty","params":[0.000000004]}"#,
        1_000,
    )?;
    session.upstream_frame(
        r#"{"id":null,"method":"mining.notify","params":["job-diff-4","0000000000000000000000000000000000000000000000000000000000000000","01000000","00",[],"20000000","1d00ffff","5f5e1000",true]}"#,
        1_000,
    )?;
    session.upstream_frame(
        r#"{"id":null,"method":"mining.set_difficulty","params":[0.000000001]}"#,
        1_001,
    )?;
    let nonce = worked_nonce(
        "01020304",
        "00000001",
        StratumJobFields::new(
            "0000000000000000000000000000000000000000000000000000000000000000",
            "01000000",
            "00",
            "20000000",
            "1d00ffff",
            "5f5e1000",
        ),
        hex_target("0ee6a3994d800000000000000000000000000000000000000000000000000000")?,
    )?;
    session.worker_frame(
        &format!(r#"{{"id":9,"method":"mining.submit","params":["bwg-session-stale","job-diff-4","00000001","5f5e1000","{nonce}"]}}"#),
        1_001,
    )?;

    // Act
    let actions = session.upstream_frame(r#"{"id":9,"result":true,"error":null}"#, 1_002)?;

    // Assert
    let [
        StratumProxyAction::PersistAccepted {
            event,
            lease_context,
            ..
        },
    ] = actions.as_slice()
    else {
        return Err("accepted result must request persistence".into());
    };
    assert_eq!(
        event.assigned_target_be_bytes(),
        hex_target("0ee6a3994d800000000000000000000000000000000000000000000000000000")?
    );
    assert_eq!(lease_context.last_monotonic_milliseconds(), 1_000);
    Ok(())
}

#[test]
fn distinct_session_extranonces_produce_distinct_share_fingerprints() -> Result<(), Box<dyn Error>>
{
    // Arrange
    let mut first = prepared_submit_session(
        "session_stratum_cross_01",
        "worker-cross-01",
        21,
        "01020304",
        1_060,
    )?;
    let mut second = prepared_submit_session(
        "session_stratum_cross_02",
        "worker-cross-02",
        22,
        "05060708",
        1_060,
    )?;

    // Act
    let first_actions = first.upstream_frame(r#"{"id":21,"result":true,"error":null}"#, 1_002)?;
    let second_actions = second.upstream_frame(r#"{"id":22,"result":true,"error":null}"#, 1_002)?;
    let [
        StratumProxyAction::PersistAccepted {
            event: first_event, ..
        },
    ] = first_actions.as_slice()
    else {
        return Err("first accepted share must request persistence".into());
    };
    let [
        StratumProxyAction::PersistAccepted {
            event: second_event,
            ..
        },
    ] = second_actions.as_slice()
    else {
        return Err("second accepted share must request persistence".into());
    };

    // Assert
    assert_ne!(first_event, second_event);
    assert_ne!(
        first_event.share_fingerprint(),
        second_event.share_fingerprint()
    );
    Ok(())
}

#[test]
fn rejected_submission_returns_upstream_result_without_persistence() -> Result<(), Box<dyn Error>> {
    // Arrange
    let mut session = prepared_submit_session(
        "session_stratum_rejected_01",
        "worker-rejected-01",
        61,
        "11121314",
        1_060,
    )?;
    let rejected = r#"{"id":61,"result":false,"error":[23,"low difficulty share",null]}"#;

    // Act
    let actions = session.upstream_frame(rejected, 1_002)?;

    // Assert
    assert_eq!(
        actions,
        [StratumProxyAction::ForwardWorker(rejected.to_owned())]
    );
    Ok(())
}

#[test]
fn rejected_subscribe_response_is_forwarded_unchanged() -> Result<(), Box<dyn Error>> {
    // Arrange
    let mut session = StratumSession::new(StratumSessionConfig::new(
        WorkSessionId::try_from("session_stratum_subscribe_rejected_01".to_owned())?,
        test_lease_context()?,
        "bwg-subscribe-rejected".to_owned(),
        "subscribe-rejected-secret".to_owned(),
        1_000,
        1_060,
        2_000,
    )?)?;
    session.worker_frame(
        r#"{"id":91,"method":"mining.subscribe","params":[]}"#,
        1_000,
    )?;
    let rejected = r#"{"id":91,"result":null,"error":[20,"subscription rejected",null]}"#;

    // Act
    let actions = session.upstream_frame(rejected, 1_001)?;

    // Assert
    assert_eq!(
        actions,
        [StratumProxyAction::ForwardWorker(rejected.to_owned())]
    );
    Ok(())
}

#[test]
fn submit_cannot_name_another_sessions_username() -> Result<(), Box<dyn Error>> {
    // Arrange
    let mut session = authorized_session()?;
    session.upstream_frame(
        r#"{"id":null,"method":"mining.notify","params":["job-username","0000000000000000000000000000000000000000000000000000000000000000","01000000","00",[],"20000000","1d00ffff","5f5e1000",true]}"#,
        1_000,
    )?;
    let submit = r#"{"id":63,"method":"mining.submit","params":["bwg-another-session","job-username","00000001","5f5e1000","abcdef01"]}"#;

    // Act
    let result = session.worker_frame(submit, 1_001);

    // Assert
    assert!(matches!(result, Err(StratumV1Error::InvalidCredentials)));
    Ok(())
}

#[test]
fn outstanding_json_rpc_id_cannot_be_reused_for_another_submit() -> Result<(), Box<dyn Error>> {
    // Arrange
    let mut session = authorized_session()?;
    session.upstream_frame(
        r#"{"id":null,"method":"mining.notify","params":["job-duplicate-id","0000000000000000000000000000000000000000000000000000000000000000","01000000","00",[],"20000000","1d00ffff","5f5e1000",true]}"#,
        1_000,
    )?;
    session.worker_frame(
        r#"{"id":80,"method":"mining.submit","params":["bwg-session-stale","job-duplicate-id","00000001","5f5e1000","abcdef01"]}"#,
        1_001,
    )?;

    // Act
    let result = session.worker_frame(
        r#"{"id":80,"method":"mining.submit","params":["bwg-session-stale","job-duplicate-id","00000002","5f5e1000","abcdef02"]}"#,
        1_001,
    );

    // Assert
    assert!(matches!(result, Err(StratumV1Error::DuplicateRequestId)));
    Ok(())
}

#[test]
fn accepted_response_at_expiry_completes_a_submit_forwarded_while_valid()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let mut session = prepared_submit_session_with_context(
        "session_stratum_inflight_expiry_01",
        "worker-inflight-expiry-01",
        93,
        "31323334",
        1_002,
        StratumLeaseContext::new(
            "00000000-0000-4000-8000-000000000204".to_owned(),
            "boot_inflight_expiry".to_owned(),
            0,
            1_000,
            2_000,
        )?,
    )?;

    // Act
    let actions = session.upstream_frame(r#"{"id":93,"result":true,"error":null}"#, 1_002)?;

    // Assert
    assert!(matches!(
        actions.as_slice(),
        [StratumProxyAction::PersistAccepted { .. }]
    ));
    Ok(())
}

#[test]
fn clean_notify_rejects_a_submit_for_the_superseded_job() -> Result<(), Box<dyn Error>> {
    // Arrange
    let mut session = authorized_session()?;
    let first_notify = r#"{"id":null,"method":"mining.notify","params":["job-old","0000000000000000000000000000000000000000000000000000000000000000","01000000","00",[],"20000000","1d00ffff","5f5e1000",true]}"#;
    let replacement_notify = r#"{"id":null,"method":"mining.notify","params":["job-current","0000000000000000000000000000000000000000000000000000000000000000","01000000","00",[],"20000000","1d00ffff","5f5e1001",true]}"#;
    let stale_submit = r#"{"id":7,"method":"mining.submit","params":["bwg-session-stale","job-old","00000001","5f5e1000","abcdef01"]}"#;
    session.upstream_frame(first_notify, 1_000)?;
    session.upstream_frame(replacement_notify, 1_001)?;

    // Act
    let result = session.worker_frame(stale_submit, 1_002);

    // Assert
    assert!(matches!(result, Err(StratumV1Error::UnknownJob)));
    Ok(())
}

fn authorized_session() -> Result<StratumSession, Box<dyn Error>> {
    let mut session = StratumSession::new(StratumSessionConfig::new(
        WorkSessionId::try_from("session_stratum_stale_01".to_owned())?,
        test_lease_context()?,
        "bwg-session-stale".to_owned(),
        "stratum-session-secret-stale".to_owned(),
        1_000,
        1_060,
        2_000,
    )?)?;
    session.worker_frame(
        r#"{"id":1,"method":"mining.authorize","params":["bwg-session-stale","stratum-session-secret-stale"]}"#,
        1_000,
    )?;
    session.upstream_frame(r#"{"id":1,"result":true,"error":null}"#, 1_000)?;
    session.worker_frame(r#"{"id":2,"method":"mining.subscribe","params":[]}"#, 1_000)?;
    let subscribe_actions = session.upstream_frame(
        r#"{"id":2,"result":[[["mining.notify","authorized"]],"01020304",4],"error":null}"#,
        1_000,
    )?;
    let [StratumProxyAction::ReserveExtranonce { token, .. }] = subscribe_actions.as_slice() else {
        return Err("authorized session needs extranonce reservation".into());
    };
    let _ = session.extranonce_reserved(token)?;
    session.upstream_frame(
        r#"{"id":null,"method":"mining.set_difficulty","params":[0.000000001]}"#,
        1_000,
    )?;
    Ok(session)
}

fn prepared_submit_session(
    session_id: &str,
    username: &str,
    request_id: u64,
    extranonce1: &str,
    expires_at_unix_seconds: u64,
) -> Result<StratumSession, Box<dyn Error>> {
    prepared_submit_session_with_context(
        session_id,
        username,
        request_id,
        extranonce1,
        expires_at_unix_seconds,
        test_lease_context()?,
    )
}

fn prepared_submit_session_with_context(
    session_id: &str,
    username: &str,
    request_id: u64,
    extranonce1: &str,
    expires_at_unix_seconds: u64,
    lease_context: StratumLeaseContext,
) -> Result<StratumSession, Box<dyn Error>> {
    let mut session = StratumSession::new(StratumSessionConfig::new(
        WorkSessionId::try_from(session_id.to_owned())?,
        lease_context,
        username.to_owned(),
        "cross-session-secret".to_owned(),
        1_000,
        expires_at_unix_seconds,
        2_000,
    )?)?;
    session.worker_frame(
        &format!(
            r#"{{"id":1,"method":"mining.authorize","params":["{username}","cross-session-secret"]}}"#
        ),
        1_000,
    )?;
    session.upstream_frame(r#"{"id":1,"result":true,"error":null}"#, 1_000)?;
    session.worker_frame(r#"{"id":2,"method":"mining.subscribe","params":[]}"#, 1_000)?;
    let subscribe_actions = session.upstream_frame(
        &format!(
            r#"{{"id":2,"result":[[["mining.notify","prepared"]],"{extranonce1}",4],"error":null}}"#
        ),
        1_000,
    )?;
    let [StratumProxyAction::ReserveExtranonce { token, .. }] = subscribe_actions.as_slice() else {
        return Err("prepared session needs extranonce reservation".into());
    };
    let _ = session.extranonce_reserved(token)?;
    session.upstream_frame(
        r#"{"id":null,"method":"mining.set_difficulty","params":[0.000000001]}"#,
        1_000,
    )?;
    session.upstream_frame(
        r#"{"id":null,"method":"mining.notify","params":["job-cross","0000000000000000000000000000000000000000000000000000000000000000","01000000","00",[],"20000000","1d00ffff","5f5e1000",true]}"#,
        1_000,
    )?;
    let nonce = worked_nonce(
        extranonce1,
        "00000001",
        StratumJobFields::new(
            "0000000000000000000000000000000000000000000000000000000000000000",
            "01000000",
            "00",
            "20000000",
            "1d00ffff",
            "5f5e1000",
        ),
        hex_target("3b9a8e6536000000000000000000000000000000000000000000000000000000")?,
    )?;
    session.worker_frame(
        &format!(
            r#"{{"id":{request_id},"method":"mining.submit","params":["{username}","job-cross","00000001","5f5e1000","{nonce}"]}}"#
        ),
        1_001,
    )?;
    Ok(session)
}

fn persisted_event(event_id: &str, share_id: &str) -> Result<AcceptedWorkEvent, Box<dyn Error>> {
    Ok(AcceptedWorkEvent::try_from(AcceptedWorkEventInput {
        event_id: AcceptedWorkEventId::try_from(event_id.to_owned())?,
        work_session_id: WorkSessionId::try_from("session_stratum_outbox_01".to_owned())?,
        assigned_target: hex_target(
            "00000000ffff0000000000000000000000000000000000000000000000000000",
        )?,
        received_at: ReceiptTime::try_from(1_000)?,
        share_fingerprint: ShareFingerprint::try_from(share_id.to_owned())?,
        network_target_outcome: NetworkTargetOutcome::BelowNetworkTarget,
        maybe_worker_report: None,
    })?)
}

async fn simulated_upstream(
    listener: TcpListener,
    username: String,
    secret: String,
) -> Result<(), std::io::Error> {
    let (stream, _) = listener.accept().await?;
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    let _subscribe = lines.next_line().await?;
    write_line(
        &mut write,
        r#"{"id":1,"result":[[["mining.notify","subscription-tcp"]],"01020304",4],"error":null}"#,
    )
    .await?;
    let authorize = lines.next_line().await?;
    if !authorize.is_some_and(|line| line.contains(&username) && line.contains(&secret)) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "proxy changed Stratum authorization",
        ));
    }
    write_line(&mut write, r#"{"id":2,"result":true,"error":null}"#).await?;
    write_line(
        &mut write,
        r#"{"id":null,"method":"mining.set_difficulty","params":[0.000000001]}"#,
    )
    .await?;
    write_line(
        &mut write,
        r#"{"id":null,"method":"mining.notify","params":["job-tcp-01","0000000000000000000000000000000000000000000000000000000000000000","01000000","00",[],"20000000","1d00ffff","5f5e1000",true]}"#,
    )
    .await?;
    let _submit = lines.next_line().await?;
    write_line(&mut write, r#"{"id":3,"result":true,"error":null}"#).await?;
    while lines.next_line().await?.is_some() {}
    Ok(())
}

async fn write_line<W>(writer: &mut W, line: &str) -> Result<(), std::io::Error>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    writer.write_all(line.as_bytes()).await?;
    writer.write_all(b"\n").await?;
    writer.flush().await
}

struct RecordingSink {
    fail_next: AtomicBool,
    attempts: Arc<Mutex<Vec<AcceptedWorkEvent>>>,
}

impl RecordingSink {
    fn fail_once() -> Self {
        Self {
            fail_next: AtomicBool::new(true),
            attempts: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn attempts(&self) -> Vec<AcceptedWorkEvent> {
        self.attempts
            .lock()
            .expect("recording sink lock should remain available")
            .clone()
    }
}

#[async_trait]
impl AcceptedWorkSink for RecordingSink {
    async fn deliver(
        &self,
        event: AcceptedWorkEvent,
        _lease_context: StratumLeaseContext,
    ) -> Result<(), AcceptedWorkSinkError> {
        self.attempts
            .lock()
            .map_err(|_| AcceptedWorkSinkError::Unavailable)?
            .push(event);
        if self.fail_next.swap(false, Ordering::SeqCst) {
            return Err(AcceptedWorkSinkError::Unavailable);
        }
        Ok(())
    }
}
