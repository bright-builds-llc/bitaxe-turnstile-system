use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::{
    io::{
        AsyncBufRead, AsyncBufReadExt as _, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _,
        BufReader,
    },
    net::{
        TcpListener, TcpStream,
        tcp::{OwnedReadHalf, OwnedWriteHalf},
    },
};

use super::{
    MAXIMUM_STRATUM_FRAME_BYTES, PostgresAcceptedWorkOutbox, PostgresStratumSessionRegistry,
    StratumProxyAction, StratumSession, StratumV1Error,
};

/// TCP adapter that executes one pure Stratum Session against one upstream connection.
#[derive(Clone)]
pub struct StratumTcpProxy {
    outbox: PostgresAcceptedWorkOutbox,
    sessions: PostgresStratumSessionRegistry,
    idle_timeout: Duration,
}

impl StratumTcpProxy {
    pub fn new(
        outbox: PostgresAcceptedWorkOutbox,
        sessions: PostgresStratumSessionRegistry,
    ) -> Self {
        Self {
            outbox,
            sessions,
            idle_timeout: Duration::from_secs(90),
        }
    }

    pub fn with_idle_timeout(
        outbox: PostgresAcceptedWorkOutbox,
        sessions: PostgresStratumSessionRegistry,
        idle_timeout: Duration,
    ) -> Result<Self, StratumV1Error> {
        if idle_timeout.is_zero() || idle_timeout > Duration::from_secs(3_600) {
            return Err(StratumV1Error::InvalidSessionConfig);
        }
        Ok(Self {
            outbox,
            sessions,
            idle_timeout,
        })
    }

    pub async fn serve_one(
        &self,
        listener: &TcpListener,
        upstream_address: std::net::SocketAddr,
    ) -> Result<(), StratumV1Error> {
        let (worker, _) = listener.accept().await?;
        let upstream = TcpStream::connect(upstream_address).await?;
        self.admit_and_run(worker, upstream).await
    }

    pub async fn admit_and_run(
        &self,
        worker: TcpStream,
        upstream: TcpStream,
    ) -> Result<(), StratumV1Error> {
        let (worker_read, mut worker_write) = worker.into_split();
        let (upstream_read, mut upstream_write) = upstream.into_split();
        let mut worker_reader = BufReader::new(worker_read);
        let mut upstream_reader = BufReader::new(upstream_read);
        let connection_id = uuid::Uuid::new_v4().to_string();
        let subscribe = next_frame(&mut worker_reader, self.idle_timeout)
            .await?
            .ok_or(StratumV1Error::InvalidFrame)?;
        if message_method(&subscribe)? != "mining.subscribe" {
            return Err(StratumV1Error::AuthorizationRequired);
        }
        write_line(&mut upstream_write, &subscribe).await?;
        let subscribed = next_frame(&mut upstream_reader, self.idle_timeout)
            .await?
            .ok_or(StratumV1Error::InvalidFrame)?;
        let Some(reserved_extranonce1) = subscription_extranonce(&subscribed)? else {
            write_line(&mut worker_write, &subscribed).await?;
            return Ok(());
        };
        let reserved_at = current_unix_seconds()?;
        self.sessions
            .reserve_connection(&connection_id, &reserved_extranonce1, reserved_at)
            .await?;
        let admission_result = async {
            write_line(&mut worker_write, &subscribed).await?;
            let authorize = next_frame(&mut worker_reader, self.idle_timeout)
                .await?
                .ok_or(StratumV1Error::InvalidFrame)?;
            let (request_id, username, secret) = authorization_request(&authorize)?;
            let now = current_unix_seconds()?;
            let maybe_authenticated = self.sessions.authenticate(&username, &secret, now).await?;
            let Some(authenticated) = maybe_authenticated else {
                write_line(
                    &mut worker_write,
                    &format!("{{\"id\":{request_id},\"result\":false,\"error\":null}}"),
                )
                .await?;
                return Ok(());
            };
            self.sessions
                .bind_connection(&connection_id, authenticated.session_id())
                .await?;
            let mut session =
                StratumSession::new(authenticated.into_session_config(username, secret, now)?)?;
            let _ = session.worker_frame(&subscribe, now)?;
            let subscribe_actions = session.upstream_frame(&subscribed, now)?;
            let [
                StratumProxyAction::ReserveExtranonce {
                    token,
                    session_id: _,
                    extranonce1,
                },
            ] = subscribe_actions.as_slice()
            else {
                return Err(StratumV1Error::InvalidFrame);
            };
            if !extranonce1.eq_ignore_ascii_case(&reserved_extranonce1) {
                return Err(StratumV1Error::ExtranonceCollision);
            }
            let _ = session.extranonce_reserved(token)?;
            let authorize_actions = session.worker_frame(&authorize, now)?;
            let [StratumProxyAction::ForwardUpstream(authorize)] = authorize_actions.as_slice()
            else {
                return Err(StratumV1Error::InvalidFrame);
            };
            write_line(&mut upstream_write, authorize).await?;
            self.run_established(
                worker_reader,
                worker_write,
                upstream_reader,
                upstream_write,
                session,
                connection_id.clone(),
            )
            .await
        }
        .await;
        let cleanup_result = self
            .sessions
            .release_unbound_connection(&connection_id)
            .await;
        match (admission_result, cleanup_result) {
            (Err(admission), Err(cleanup)) => Err(StratumV1Error::AdmissionCleanup {
                admission: Box::new(admission),
                cleanup: Box::new(cleanup),
            }),
            (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
            (Ok(()), Ok(())) => Ok(()),
        }
    }

    async fn run_established(
        &self,
        mut worker_reader: BufReader<OwnedReadHalf>,
        mut worker_write: OwnedWriteHalf,
        mut upstream_reader: BufReader<OwnedReadHalf>,
        mut upstream_write: OwnedWriteHalf,
        mut session: StratumSession,
        connection_id: String,
    ) -> Result<(), StratumV1Error> {
        loop {
            tokio::select! {
                maybe_line = next_frame(&mut worker_reader, self.idle_timeout) => {
                    let Some(line) = maybe_line? else { return Ok(()); };
                    let actions = session.worker_frame(&line, current_unix_seconds()?)?;
                    self.execute_actions(
                        actions,
                        &mut session,
                        &mut worker_write,
                        &mut upstream_write,
                        &connection_id,
                    ).await?;
                }
                maybe_line = next_frame(&mut upstream_reader, self.idle_timeout) => {
                    let Some(line) = maybe_line? else { return Ok(()); };
                    let actions = session.upstream_frame(&line, current_unix_seconds()?)?;
                    self.execute_actions(
                        actions,
                        &mut session,
                        &mut worker_write,
                        &mut upstream_write,
                        &connection_id,
                    ).await?;
                }
            }
        }
    }

    async fn execute_actions<W, U>(
        &self,
        actions: Vec<StratumProxyAction>,
        session: &mut StratumSession,
        worker: &mut W,
        upstream: &mut U,
        connection_id: &str,
    ) -> Result<(), StratumV1Error>
    where
        W: AsyncWrite + Unpin,
        U: AsyncWrite + Unpin,
    {
        for action in actions {
            match action {
                StratumProxyAction::ForwardUpstream(frame) => write_line(upstream, &frame).await?,
                StratumProxyAction::ForwardWorker(frame) => write_line(worker, &frame).await?,
                StratumProxyAction::ReserveExtranonce {
                    token,
                    session_id,
                    extranonce1,
                } => {
                    self.sessions
                        .reserve_extranonce(
                            &session_id,
                            connection_id,
                            &extranonce1,
                            current_unix_seconds()?,
                        )
                        .await?;
                    let next = session.extranonce_reserved(&token)?;
                    if let StratumProxyAction::ForwardWorker(frame) = next {
                        write_line(worker, &frame).await?;
                    }
                }
                StratumProxyAction::PersistAccepted {
                    token,
                    event,
                    lease_context,
                    worker_response,
                } => {
                    let persisted = self
                        .outbox
                        .persist(&event, &lease_context, &worker_response)
                        .await?;
                    let _ = session.accepted_persisted(&token)?;
                    write_line(worker, persisted.worker_response()).await?;
                }
            }
        }
        Ok(())
    }
}

fn message_method(frame: &str) -> Result<String, StratumV1Error> {
    serde_json::from_str::<serde_json::Value>(frame)
        .ok()
        .and_then(|value| {
            value
                .get("method")
                .and_then(|method| method.as_str())
                .map(str::to_owned)
        })
        .ok_or(StratumV1Error::InvalidFrame)
}

fn subscription_extranonce(frame: &str) -> Result<Option<String>, StratumV1Error> {
    let value = serde_json::from_str::<serde_json::Value>(frame)
        .map_err(|_| StratumV1Error::InvalidFrame)?;
    let Some(result) = value.get("result").and_then(|result| result.as_array()) else {
        return Ok(None);
    };
    result
        .get(1)
        .and_then(|value| value.as_str())
        .map(str::to_owned)
        .map(Some)
        .ok_or(StratumV1Error::InvalidExtranonce)
}

fn authorization_request(frame: &str) -> Result<(String, String, String), StratumV1Error> {
    let value = serde_json::from_str::<serde_json::Value>(frame)
        .map_err(|_| StratumV1Error::InvalidFrame)?;
    if value.get("method").and_then(|method| method.as_str()) != Some("mining.authorize") {
        return Err(StratumV1Error::AuthorizationRequired);
    }
    let id = value.get("id").ok_or(StratumV1Error::InvalidFrame)?;
    let request_id = serde_json::to_string(id).map_err(|_| StratumV1Error::InvalidFrame)?;
    let params = value
        .get("params")
        .and_then(|params| params.as_array())
        .ok_or(StratumV1Error::InvalidFrame)?;
    let username = params
        .first()
        .and_then(|value| value.as_str())
        .ok_or(StratumV1Error::InvalidFrame)?
        .to_owned();
    let secret = params
        .get(1)
        .and_then(|value| value.as_str())
        .ok_or(StratumV1Error::InvalidFrame)?
        .to_owned();
    Ok((request_id, username, secret))
}

async fn next_frame<R>(
    reader: &mut R,
    idle_timeout: Duration,
) -> Result<Option<String>, StratumV1Error>
where
    R: AsyncBufRead + Unpin,
{
    tokio::time::timeout(idle_timeout, read_bounded_frame(reader))
        .await
        .map_err(|_| StratumV1Error::IdleTimeout)?
}

async fn read_bounded_frame<R>(reader: &mut R) -> Result<Option<String>, StratumV1Error>
where
    R: AsyncBufRead + Unpin,
{
    let mut bytes = Vec::new();
    let count = reader
        .take(u64::try_from(MAXIMUM_STRATUM_FRAME_BYTES + 1).expect("frame limit fits u64"))
        .read_until(b'\n', &mut bytes)
        .await?;
    if count == 0 {
        return Ok(None);
    }
    if bytes.len() > MAXIMUM_STRATUM_FRAME_BYTES || bytes.last() != Some(&b'\n') {
        return Err(StratumV1Error::FrameTooLarge);
    }
    bytes.pop();
    if bytes.last() == Some(&b'\r') {
        bytes.pop();
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| StratumV1Error::InvalidFrame)
}

async fn write_line<W>(writer: &mut W, frame: &str) -> Result<(), std::io::Error>
where
    W: AsyncWrite + Unpin,
{
    writer.write_all(frame.as_bytes()).await?;
    writer.write_all(b"\n").await?;
    writer.flush().await
}

fn current_unix_seconds() -> Result<u64, StratumV1Error> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs())
}
