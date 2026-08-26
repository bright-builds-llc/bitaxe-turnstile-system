use std::collections::HashMap;

use ring::digest;
use serde_json::Value;
use thiserror::Error;

use crate::progress::{
    AcceptedWorkEvent, AcceptedWorkEventId, AcceptedWorkEventInput, ReceiptTime, ShareFingerprint,
    WorkSessionId,
};

mod credentials;
mod delivery;
mod postgres;
mod retention;
mod sessions;
mod target;
mod tcp;
pub use delivery::{
    AcceptedWorkDeliveryWorker, AcceptedWorkSink, AcceptedWorkSinkError, DeliveryOutcome,
};
pub use postgres::{ClaimedAcceptedWork, PersistedAcceptedWork, PostgresAcceptedWorkOutbox};
pub use retention::{PoolAdapterRetentionCounts, PostgresPoolAdapterRetention};
pub use sessions::{AuthenticatedStratumSession, PostgresStratumSessionRegistry};
use target::{classify_network_target, submitted_header, target_for_difficulty};
pub use tcp::StratumTcpProxy;

pub(crate) const MAXIMUM_STRATUM_FRAME_BYTES: usize = 16 * 1024;
const MAXIMUM_OUTSTANDING_REQUESTS: usize = 64;
const MAXIMUM_RETAINED_JOBS: usize = 64;

/// Opaque handle released only after one accepted submission is durably recorded.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct AcceptedSubmissionToken(String);

/// Opaque handle released only after one upstream extranonce is globally reserved.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ExtranonceReservationToken(String);

/// Global active-session registry preventing two Work Sessions from sharing coinbase space.
#[derive(Default)]
pub struct ExtranonceSpace {
    sessions_by_extranonce: HashMap<String, WorkSessionId>,
}

impl ExtranonceSpace {
    pub fn reserve(
        &mut self,
        session_id: &WorkSessionId,
        extranonce1: &str,
    ) -> Result<(), StratumV1Error> {
        if extranonce1.is_empty()
            || extranonce1.len() > 64
            || !extranonce1.len().is_multiple_of(2)
            || !extranonce1.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(StratumV1Error::InvalidExtranonce);
        }
        let canonical_extranonce = extranonce1.to_ascii_lowercase();
        if let Some(existing_session) = self.sessions_by_extranonce.get(&canonical_extranonce) {
            if existing_session == session_id {
                return Ok(());
            }
            return Err(StratumV1Error::ExtranonceCollision);
        }
        self.sessions_by_extranonce
            .insert(canonical_extranonce, session_id.clone());
        Ok(())
    }
}

/// One effect requested by the pure Stratum V1 session module.
#[derive(Debug, Clone, PartialEq)]
pub enum StratumProxyAction {
    ForwardUpstream(String),
    ForwardWorker(String),
    ReserveExtranonce {
        token: ExtranonceReservationToken,
        session_id: WorkSessionId,
        extranonce1: String,
    },
    PersistAccepted {
        token: AcceptedSubmissionToken,
        event: Box<AcceptedWorkEvent>,
        lease_context: StratumLeaseContext,
        worker_response: String,
    },
}

/// Stateful standard Stratum V1 transcript with a persistence-before-acknowledgement interface.
pub struct StratumSession {
    config: StratumSessionConfig,
    authorized: bool,
    maybe_current_target: Option<[u8; 32]>,
    jobs: HashMap<String, StratumJob>,
    outstanding_requests: HashMap<String, OutstandingRequest>,
    awaiting_persistence: HashMap<AcceptedSubmissionToken, String>,
    awaiting_extranonce: HashMap<ExtranonceReservationToken, PendingExtranonce>,
    maybe_extranonce1: Option<String>,
    maybe_extranonce2_size: Option<usize>,
}

struct PendingSubmission {
    request: String,
    job: StratumJob,
    extranonce1: String,
    extranonce2: String,
    ntime: String,
    nonce: String,
    target: [u8; 32],
    lease_context: StratumLeaseContext,
}

#[derive(Clone)]
struct StratumJob {
    previous_block_hash: String,
    coinbase_prefix: String,
    coinbase_suffix: String,
    merkle_branches: Vec<String>,
    version: String,
    network_bits: String,
    assigned_target: [u8; 32],
}

struct PendingExtranonce {
    response: String,
    extranonce1: String,
    extranonce2_size: usize,
}

enum OutstandingRequest {
    Subscribe,
    Authorize,
    Submit(Box<PendingSubmission>),
    Passthrough,
}

impl StratumSession {
    pub fn new(config: StratumSessionConfig) -> Result<Self, StratumV1Error> {
        if config.username.is_empty()
            || config.secret.is_empty()
            || config.expires_at_unix_seconds == 0
        {
            return Err(StratumV1Error::InvalidSessionConfig);
        }
        Ok(Self {
            config,
            authorized: false,
            maybe_current_target: None,
            jobs: HashMap::new(),
            outstanding_requests: HashMap::new(),
            awaiting_persistence: HashMap::new(),
            awaiting_extranonce: HashMap::new(),
            maybe_extranonce1: None,
            maybe_extranonce2_size: None,
        })
    }

    pub fn worker_frame(
        &mut self,
        frame: &str,
        now_unix_seconds: u64,
    ) -> Result<Vec<StratumProxyAction>, StratumV1Error> {
        self.require_unexpired(now_unix_seconds)?;
        if frame.len() > MAXIMUM_STRATUM_FRAME_BYTES {
            return Err(StratumV1Error::FrameTooLarge);
        }
        let message = parse_object(frame)?;
        let maybe_request = match message.get("method").and_then(Value::as_str) {
            Some("mining.subscribe") => Some(OutstandingRequest::Subscribe),
            Some("mining.authorize") => {
                let params = message
                    .get("params")
                    .and_then(Value::as_array)
                    .ok_or(StratumV1Error::InvalidFrame)?;
                if params.first().and_then(Value::as_str) != Some(&self.config.username)
                    || params.get(1).and_then(Value::as_str) != Some(&self.config.secret)
                {
                    let id = message_id(&message)?;
                    return Ok(vec![StratumProxyAction::ForwardWorker(format!(
                        "{{\"id\":{id},\"result\":false,\"error\":null}}"
                    ))]);
                }
                Some(OutstandingRequest::Authorize)
            }
            Some("mining.submit") => {
                if !self.authorized {
                    return Err(StratumV1Error::AuthorizationRequired);
                }
                let _ = self
                    .maybe_current_target
                    .ok_or(StratumV1Error::TargetRequired)?;
                let extranonce1 = self
                    .maybe_extranonce1
                    .as_deref()
                    .ok_or(StratumV1Error::InvalidExtranonce)?;
                let extranonce2_size = self
                    .maybe_extranonce2_size
                    .ok_or(StratumV1Error::InvalidExtranonce)?;
                let params = message
                    .get("params")
                    .and_then(Value::as_array)
                    .ok_or(StratumV1Error::InvalidFrame)?;
                if params.first().and_then(Value::as_str) != Some(&self.config.username) {
                    return Err(StratumV1Error::InvalidCredentials);
                }
                if params.len() != 5 {
                    return Err(StratumV1Error::UnknownJob);
                }
                let job_id = params
                    .get(1)
                    .and_then(Value::as_str)
                    .ok_or(StratumV1Error::UnknownJob)?;
                let job = self.jobs.get(job_id).ok_or(StratumV1Error::UnknownJob)?;
                let extranonce2 = params
                    .get(2)
                    .and_then(Value::as_str)
                    .ok_or(StratumV1Error::InvalidFrame)?;
                if extranonce2.len() != extranonce2_size * 2 {
                    return Err(StratumV1Error::InvalidExtranonce);
                }
                let ntime = params
                    .get(3)
                    .and_then(Value::as_str)
                    .ok_or(StratumV1Error::InvalidFrame)?;
                let nonce = params
                    .get(4)
                    .and_then(Value::as_str)
                    .ok_or(StratumV1Error::InvalidFrame)?;
                Some(OutstandingRequest::Submit(Box::new(PendingSubmission {
                    request: frame.to_owned(),
                    job: job.clone(),
                    extranonce1: extranonce1.to_owned(),
                    extranonce2: extranonce2.to_owned(),
                    ntime: ntime.to_owned(),
                    nonce: nonce.to_owned(),
                    target: job.assigned_target,
                    lease_context: self.config.lease_context.advanced_by_wall_clock(
                        self.config.issued_at_unix_seconds,
                        now_unix_seconds,
                    )?,
                })))
            }
            Some(_) => Some(OutstandingRequest::Passthrough),
            None => None,
        };
        if let Some(request) = maybe_request {
            let id = message_id(&message)?;
            if self.outstanding_requests.contains_key(&id) {
                return Err(StratumV1Error::DuplicateRequestId);
            }
            if self.outstanding_requests.len() >= MAXIMUM_OUTSTANDING_REQUESTS {
                return Err(StratumV1Error::CapacityExceeded);
            }
            self.outstanding_requests.insert(id, request);
        }
        Ok(vec![StratumProxyAction::ForwardUpstream(frame.to_owned())])
    }

    pub fn upstream_frame(
        &mut self,
        frame: &str,
        now_unix_seconds: u64,
    ) -> Result<Vec<StratumProxyAction>, StratumV1Error> {
        if frame.len() > MAXIMUM_STRATUM_FRAME_BYTES {
            return Err(StratumV1Error::FrameTooLarge);
        }
        let message = parse_object(frame)?;
        if let Some(method) = message.get("method").and_then(Value::as_str) {
            self.require_unexpired(now_unix_seconds)?;
            match method {
                "mining.set_difficulty" => {
                    let difficulty = message
                        .get("params")
                        .and_then(Value::as_array)
                        .and_then(|params| params.first())
                        .ok_or(StratumV1Error::UnsupportedDifficulty)?;
                    self.maybe_current_target = Some(target_for_difficulty(difficulty)?);
                }
                "mining.notify" => {
                    let params = message
                        .get("params")
                        .and_then(Value::as_array)
                        .ok_or(StratumV1Error::InvalidFrame)?;
                    let job_id = params
                        .first()
                        .and_then(Value::as_str)
                        .ok_or(StratumV1Error::InvalidFrame)?;
                    let clean_jobs = params
                        .get(8)
                        .and_then(Value::as_bool)
                        .ok_or(StratumV1Error::InvalidFrame)?;
                    if clean_jobs {
                        self.jobs.clear();
                    }
                    if !self.jobs.contains_key(job_id) && self.jobs.len() >= MAXIMUM_RETAINED_JOBS {
                        return Err(StratumV1Error::CapacityExceeded);
                    }
                    let string_at = |index| {
                        params
                            .get(index)
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                            .ok_or(StratumV1Error::InvalidFrame)
                    };
                    let merkle_branches = params
                        .get(4)
                        .and_then(Value::as_array)
                        .ok_or(StratumV1Error::InvalidFrame)?
                        .iter()
                        .map(|value| {
                            value
                                .as_str()
                                .map(str::to_owned)
                                .ok_or(StratumV1Error::InvalidFrame)
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    self.jobs.insert(
                        job_id.to_owned(),
                        StratumJob {
                            previous_block_hash: string_at(1)?,
                            coinbase_prefix: string_at(2)?,
                            coinbase_suffix: string_at(3)?,
                            merkle_branches,
                            version: string_at(5)?,
                            network_bits: string_at(6)?,
                            assigned_target: self
                                .maybe_current_target
                                .ok_or(StratumV1Error::TargetRequired)?,
                        },
                    );
                }
                _ => {}
            }
            return Ok(vec![StratumProxyAction::ForwardWorker(frame.to_owned())]);
        }
        let id = message_id(&message)?;
        let Some(request) = self.outstanding_requests.remove(&id) else {
            return Ok(vec![StratumProxyAction::ForwardWorker(frame.to_owned())]);
        };
        let submission = match request {
            OutstandingRequest::Subscribe => {
                let maybe_extranonce1 = message
                    .get("result")
                    .and_then(Value::as_array)
                    .and_then(|result| result.get(1))
                    .and_then(Value::as_str);
                let Some(extranonce1) = maybe_extranonce1 else {
                    return Ok(vec![StratumProxyAction::ForwardWorker(frame.to_owned())]);
                };
                let extranonce2_size = message
                    .get("result")
                    .and_then(Value::as_array)
                    .and_then(|result| result.get(2))
                    .and_then(Value::as_u64)
                    .and_then(|size| usize::try_from(size).ok())
                    .filter(|size| (1..=32).contains(size))
                    .ok_or(StratumV1Error::InvalidExtranonce)?;
                let token = ExtranonceReservationToken(id);
                self.awaiting_extranonce.insert(
                    token.clone(),
                    PendingExtranonce {
                        response: frame.to_owned(),
                        extranonce1: extranonce1.to_owned(),
                        extranonce2_size,
                    },
                );
                return Ok(vec![StratumProxyAction::ReserveExtranonce {
                    token,
                    session_id: self.config.session_id.clone(),
                    extranonce1: extranonce1.to_owned(),
                }]);
            }
            OutstandingRequest::Authorize => {
                if message.get("result").and_then(Value::as_bool) == Some(true) {
                    self.authorized = true;
                }
                return Ok(vec![StratumProxyAction::ForwardWorker(frame.to_owned())]);
            }
            OutstandingRequest::Submit(submission) => *submission,
            OutstandingRequest::Passthrough => {
                return Ok(vec![StratumProxyAction::ForwardWorker(frame.to_owned())]);
            }
        };
        if message.get("result").and_then(Value::as_bool) != Some(true) {
            return Ok(vec![StratumProxyAction::ForwardWorker(frame.to_owned())]);
        }
        let header = submitted_header(
            &submission.job,
            &submission.extranonce1,
            &submission.extranonce2,
            &submission.ntime,
            &submission.nonce,
        )?;
        let network_target_outcome =
            classify_network_target(&header, &submission.job.network_bits)?;
        let event_digest = digest_hex(
            b"BWG/0.1 accepted Stratum submission event\0",
            self.config.session_id.as_str(),
            &submission.request,
        );
        let share_digest = global_share_digest(&header);
        let event = AcceptedWorkEvent::try_from(AcceptedWorkEventInput {
            event_id: AcceptedWorkEventId::try_from(format!("event_{event_digest}"))?,
            work_session_id: self.config.session_id.clone(),
            assigned_target: submission.target,
            received_at: ReceiptTime::try_from(now_unix_seconds)?,
            share_fingerprint: ShareFingerprint::try_from(format!("share_{share_digest}"))?,
            network_target_outcome,
            maybe_worker_report: None,
        })?;
        let token = AcceptedSubmissionToken(id);
        self.awaiting_persistence
            .insert(token.clone(), frame.to_owned());
        Ok(vec![StratumProxyAction::PersistAccepted {
            token,
            event: Box::new(event),
            lease_context: submission.lease_context,
            worker_response: frame.to_owned(),
        }])
    }

    pub fn accepted_persisted(
        &mut self,
        token: &AcceptedSubmissionToken,
    ) -> Result<StratumProxyAction, StratumV1Error> {
        let response = self
            .awaiting_persistence
            .remove(token)
            .ok_or(StratumV1Error::UnknownPersistenceToken)?;
        Ok(StratumProxyAction::ForwardWorker(response))
    }

    pub fn extranonce_reserved(
        &mut self,
        token: &ExtranonceReservationToken,
    ) -> Result<StratumProxyAction, StratumV1Error> {
        let pending = self
            .awaiting_extranonce
            .remove(token)
            .ok_or(StratumV1Error::UnknownExtranonceToken)?;
        self.maybe_extranonce1 = Some(pending.extranonce1);
        self.maybe_extranonce2_size = Some(pending.extranonce2_size);
        Ok(StratumProxyAction::ForwardWorker(pending.response))
    }

    fn require_unexpired(&self, now_unix_seconds: u64) -> Result<(), StratumV1Error> {
        if now_unix_seconds >= self.config.expires_at_unix_seconds {
            return Err(StratumV1Error::ExpiredCredentials);
        }
        Ok(())
    }
}

fn parse_object(frame: &str) -> Result<serde_json::Map<String, Value>, StratumV1Error> {
    serde_json::from_str::<Value>(frame)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .ok_or(StratumV1Error::InvalidFrame)
}

fn message_id(message: &serde_json::Map<String, Value>) -> Result<String, StratumV1Error> {
    let id = message.get("id").ok_or(StratumV1Error::InvalidFrame)?;
    if id.is_null() {
        return Err(StratumV1Error::InvalidFrame);
    }
    serde_json::to_string(id).map_err(|_| StratumV1Error::InvalidFrame)
}

fn digest_hex(domain: &[u8], session_id: &str, request: &str) -> String {
    let mut input = domain.to_vec();
    input.extend_from_slice(session_id.as_bytes());
    input.push(0);
    input.extend_from_slice(request.as_bytes());
    digest::digest(&digest::SHA256, &input)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn global_share_digest(header: &[u8; 80]) -> String {
    let mut input = b"BWG/0.1 Stratum share fingerprint\0".to_vec();
    input.extend_from_slice(header);
    digest::digest(&digest::SHA256, &input)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(Debug, Error)]
pub enum StratumV1Error {
    #[error("Stratum Session configuration is invalid")]
    InvalidSessionConfig,
    #[error("Stratum V1 frame is invalid")]
    InvalidFrame,
    #[error("Stratum Session credentials are invalid")]
    InvalidCredentials,
    #[error("Stratum Session credentials expired")]
    ExpiredCredentials,
    #[error("Stratum authorization is required before submission")]
    AuthorizationRequired,
    #[error("Stratum assigned target is unavailable")]
    TargetRequired,
    #[error("Stratum difficulty is unsupported")]
    UnsupportedDifficulty,
    #[error("Stratum extranonce is invalid")]
    InvalidExtranonce,
    #[error("Stratum extranonce space is already assigned to another Work Session")]
    ExtranonceCollision,
    #[error("Stratum submission names an unknown or stale job")]
    UnknownJob,
    #[error("accepted submission persistence token is unknown")]
    UnknownPersistenceToken,
    #[error("Stratum extranonce reservation token is unknown")]
    UnknownExtranonceToken,
    #[error("Stratum JSON-RPC request identity is already outstanding")]
    DuplicateRequestId,
    #[error("Stratum V1 frame exceeds the configured size limit")]
    FrameTooLarge,
    #[error("Stratum Session state exceeds the configured capacity")]
    CapacityExceeded,
    #[error("accepted-work outbox replay conflicts with its durable event")]
    ConflictingOutboxReplay,
    #[error("Stratum Session replay conflicts with its durable credentials")]
    ConflictingSessionReplay,
    #[error("Stratum Session is not registered")]
    UnknownSession,
    #[error("accepted-work delivery lease is no longer owned by this worker")]
    LostDeliveryLease,
    #[error("Pool Adapter database operation failed")]
    Database(#[from] sqlx::Error),
    #[error("Pool Adapter migration failed")]
    Migration(#[from] sqlx::migrate::MigrateError),
    #[error("Stratum V1 transport failed")]
    Io(#[from] std::io::Error),
    #[error("Pool Adapter clock is unavailable")]
    Clock(#[from] std::time::SystemTimeError),
    #[error("Pool Adapter wall clock moved backwards during a Stratum Session")]
    ClockRollback,
    #[error("Pool Adapter retention policy is below the hosted safety floor")]
    InvalidRetentionPolicy,
    #[error(
        "Stratum admission failed ({admission}) and reservation cleanup also failed ({cleanup})"
    )]
    AdmissionCleanup {
        admission: Box<StratumV1Error>,
        cleanup: Box<StratumV1Error>,
    },
    #[error("Stratum connection exceeded its idle deadline")]
    IdleTimeout,
    #[error(transparent)]
    Progress(#[from] crate::progress::ProgressError),
}
pub use credentials::{
    StratumCredentialIssuer, StratumLeaseContext, StratumSessionConfig, StratumSessionCredentials,
};
