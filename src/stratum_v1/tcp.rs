use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

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

use crate::progress::WorkSessionId;

use super::{
    MAXIMUM_STRATUM_FRAME_BYTES, PostgresAcceptedWorkOutbox, PostgresStratumSessionRegistry,
    StratumProxyAction, StratumSession, StratumUpstreamAuthorization, StratumV1Error,
    WorkSessionDisconnectSink,
};

/// How often a live connection rereads its registration to pick up a renewed lease.
const LIVE_SESSION_REFRESH_MILLISECONDS: u64 = 5_000;

/// TCP adapter that executes one pure Stratum Session against one upstream connection.
#[derive(Clone)]
pub struct StratumTcpProxy {
    outbox: PostgresAcceptedWorkOutbox,
    sessions: PostgresStratumSessionRegistry,
    idle_timeout: Duration,
    maybe_upstream_authorization: Option<StratumUpstreamAuthorization>,
    maybe_session_upstream_secret: Option<String>,
    disconnect_sink: Arc<dyn WorkSessionDisconnectSink>,
}

impl StratumTcpProxy {
    pub fn new(
        outbox: PostgresAcceptedWorkOutbox,
        sessions: PostgresStratumSessionRegistry,
        disconnect_sink: Arc<dyn WorkSessionDisconnectSink>,
    ) -> Self {
        Self {
            outbox,
            sessions,
            idle_timeout: Duration::from_secs(90),
            maybe_upstream_authorization: None,
            maybe_session_upstream_secret: None,
            disconnect_sink,
        }
    }

    pub fn with_idle_timeout(
        outbox: PostgresAcceptedWorkOutbox,
        sessions: PostgresStratumSessionRegistry,
        idle_timeout: Duration,
        disconnect_sink: Arc<dyn WorkSessionDisconnectSink>,
    ) -> Result<Self, StratumV1Error> {
        if idle_timeout.is_zero() || idle_timeout > Duration::from_secs(3_600) {
            return Err(StratumV1Error::InvalidSessionConfig);
        }
        Ok(Self {
            outbox,
            sessions,
            idle_timeout,
            maybe_upstream_authorization: None,
            maybe_session_upstream_secret: None,
            disconnect_sink,
        })
    }

    /// Configures a Mining Pool-facing identity without exposing it to the Worker.
    pub fn with_upstream_authorization(
        mut self,
        authorization: StratumUpstreamAuthorization,
    ) -> Self {
        self.maybe_upstream_authorization = Some(authorization);
        self
    }

    /// Derives each session's Mining Pool-facing identity from its stored claimant choice.
    ///
    /// A session without a stored choice is refused at admission.
    pub fn with_session_upstream_authorization(
        mut self,
        upstream_secret: String,
    ) -> Result<Self, StratumV1Error> {
        if upstream_secret.is_empty() || upstream_secret.len() > 256 {
            return Err(StratumV1Error::InvalidSessionConfig);
        }
        self.maybe_session_upstream_secret = Some(upstream_secret);
        Ok(self)
    }

    async fn upstream_authorization_for(
        &self,
        session_id: &WorkSessionId,
        now_unix_seconds: u64,
    ) -> Result<Option<StratumUpstreamAuthorization>, StratumV1Error> {
        let Some(secret) = &self.maybe_session_upstream_secret else {
            return Ok(self.maybe_upstream_authorization.clone());
        };
        self.sessions
            .session_upstream_authorization(session_id, secret, now_unix_seconds)
            .await?
            .map(Some)
            .ok_or(StratumV1Error::UnknownSession)
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
        let mut subscribe = next_frame(&mut worker_reader, self.idle_timeout)
            .await?
            .ok_or(StratumV1Error::InvalidFrame)?;
        // Version rolling is the one negotiation a standard Worker may send first.
        let mut maybe_configure = None;
        if message_method(&subscribe)? == "mining.configure" {
            write_line(&mut upstream_write, &subscribe).await?;
            let configured = next_frame(&mut upstream_reader, self.idle_timeout)
                .await?
                .ok_or(StratumV1Error::InvalidFrame)?;
            if message_id(&configured)? != message_id(&subscribe)? {
                return Err(StratumV1Error::InvalidFrame);
            }
            write_line(&mut worker_write, &configured).await?;
            let configure = std::mem::replace(
                &mut subscribe,
                next_frame(&mut worker_reader, self.idle_timeout)
                    .await?
                    .ok_or(StratumV1Error::InvalidFrame)?,
            );
            maybe_configure = Some((configure, configured));
        }
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
            let maybe_upstream = self
                .upstream_authorization_for(authenticated.session_id(), now)
                .await?;
            if let Some(authorization) = &maybe_upstream
                && authenticated.session_id() != authorization.session_id()
            {
                return Err(StratumV1Error::UnknownSession);
            }
            self.sessions
                .bind_connection(&connection_id, authenticated.session_id())
                .await?;
            let established_session_id = authenticated.session_id().clone();
            let mut session_config = authenticated.into_session_config(username, secret, now)?;
            if let Some(authorization) = &maybe_upstream {
                session_config = session_config.with_upstream_authorization(
                    authorization.username().to_owned(),
                    authorization.secret().to_owned(),
                )?;
            }
            let mut session = StratumSession::new(session_config)?;
            if let Some((configure, configured)) = &maybe_configure {
                let _ = session.worker_frame(configure, now)?;
                let _ = session.upstream_frame(configured, now)?;
            }
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
            let transport_result = self
                .run_established(
                    worker_reader,
                    worker_write,
                    upstream_reader,
                    upstream_write,
                    session,
                    connection_id.clone(),
                )
                .await;
            let disconnect_result = self
                .disconnect_sink
                .disconnected(&established_session_id)
                .await;
            match (transport_result, disconnect_result) {
                (Ok(()), Ok(())) => Ok(()),
                (Err(error), Ok(())) => Err(error),
                (Ok(()), Err(_)) => Err(StratumV1Error::DisconnectNotificationUnavailable),
                (Err(transport), Err(_)) => {
                    Err(StratumV1Error::TransportAndDisconnectNotification {
                        transport: Box::new(transport),
                    })
                }
            }
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
        let mut next_refresh_at =
            current_unix_milliseconds()?.saturating_add(LIVE_SESSION_REFRESH_MILLISECONDS);
        loop {
            tokio::select! {
                maybe_line = next_frame(&mut worker_reader, self.idle_timeout) => {
                    let Some(line) = maybe_line? else { return Ok(()); };
                    let now = current_unix_milliseconds()?;
                    self.refresh_when_due(&mut session, &mut next_refresh_at, now).await?;
                    let actions = session.worker_frame_at(&line, now)?;
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
                    let now = current_unix_milliseconds()?;
                    self.refresh_when_due(&mut session, &mut next_refresh_at, now).await?;
                    let actions = session.upstream_frame(&line, now / 1_000)?;
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

    /// Picks up a Renew's extension, periodically and whenever the session reaches expiry.
    ///
    /// Rotated or expired credentials no longer authenticate, so the session keeps its
    /// current window and ends at that expiry as before.
    async fn refresh_when_due(
        &self,
        session: &mut StratumSession,
        next_refresh_at: &mut u64,
        now_unix_milliseconds: u64,
    ) -> Result<(), StratumV1Error> {
        let now_unix_seconds = now_unix_milliseconds / 1_000;
        if now_unix_milliseconds < *next_refresh_at
            && now_unix_seconds < session.config.expires_at_unix_seconds
        {
            return Ok(());
        }
        *next_refresh_at = now_unix_milliseconds.saturating_add(LIVE_SESSION_REFRESH_MILLISECONDS);
        let maybe_renewed = self
            .sessions
            .authenticate(
                &session.config.username,
                &session.config.secret,
                now_unix_seconds,
            )
            .await?;
        match maybe_renewed {
            Some(renewed) => session.renew(renewed),
            None => Ok(()),
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
                StratumProxyAction::ForwardUpstreamRefusal {
                    maybe_code,
                    worker_response,
                } => {
                    tracing::info!(code = ?maybe_code, "upstream refused a Stratum submit");
                    write_line(worker, &worker_response).await?;
                }
                StratumProxyAction::RefuseSubmit {
                    reason,
                    worker_response,
                } => {
                    tracing::info!(reason = reason.code(), "Stratum submit refused");
                    write_line(worker, &worker_response).await?;
                }
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

/// A request or response's non-null JSON-RPC id, in canonical JSON.
fn message_id(frame: &str) -> Result<String, StratumV1Error> {
    serde_json::from_str::<serde_json::Value>(frame)
        .ok()
        .and_then(|value| {
            value
                .get("id")
                .filter(|id| !id.is_null())
                .map(ToString::to_string)
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

fn current_unix_milliseconds() -> Result<u64, StratumV1Error> {
    u64::try_from(SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis())
        .map_err(|_| StratumV1Error::InvalidSessionConfig)
}
