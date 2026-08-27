use async_trait::async_trait;
use thiserror::Error;

use super::{PostgresAcceptedWorkOutbox, StratumLeaseContext, StratumV1Error};
use crate::progress::{AcceptedWorkEvent, WorkSessionId};

/// Gate Authority delivery seam for one durably recorded Accepted Work Event.
#[async_trait]
pub trait AcceptedWorkSink: Send + Sync {
    async fn deliver(
        &self,
        event: AcceptedWorkEvent,
        lease_context: StratumLeaseContext,
    ) -> Result<(), AcceptedWorkSinkError>;
}

/// Authority-facing seam notified when an authenticated Stratum connection ends.
#[async_trait]
pub trait WorkSessionDisconnectSink: Send + Sync {
    async fn disconnected(
        &self,
        session_id: &WorkSessionId,
    ) -> Result<(), WorkSessionDisconnectSinkError>;
}

/// Recoverable delivery loop backed by the context-local Pool Adapter outbox.
pub struct AcceptedWorkDeliveryWorker {
    outbox: PostgresAcceptedWorkOutbox,
    worker_id: String,
    lease_seconds: u64,
}

impl AcceptedWorkDeliveryWorker {
    pub fn new(
        outbox: PostgresAcceptedWorkOutbox,
        worker_id: String,
        lease_seconds: u64,
    ) -> Result<Self, StratumV1Error> {
        if lease_seconds == 0 || lease_seconds > 300 {
            return Err(StratumV1Error::InvalidSessionConfig);
        }
        Ok(Self {
            outbox,
            worker_id,
            lease_seconds,
        })
    }

    pub async fn deliver_one<S>(
        &self,
        sink: &S,
        now_unix_seconds: u64,
    ) -> Result<DeliveryOutcome, StratumV1Error>
    where
        S: AcceptedWorkSink,
    {
        let lease_expires_at = now_unix_seconds
            .checked_add(self.lease_seconds)
            .ok_or(StratumV1Error::InvalidSessionConfig)?;
        let maybe_claimed = self
            .outbox
            .claim_next(&self.worker_id, now_unix_seconds, lease_expires_at)
            .await?;
        let Some(claimed) = maybe_claimed else {
            return Ok(DeliveryOutcome::Empty);
        };
        if sink
            .deliver(claimed.event().clone(), claimed.lease_context().clone())
            .await
            .is_err()
        {
            return Ok(DeliveryOutcome::RetryableFailure);
        }
        self.outbox.acknowledge(&claimed, now_unix_seconds).await?;
        Ok(DeliveryOutcome::Acknowledged)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryOutcome {
    Empty,
    Acknowledged,
    RetryableFailure,
}

#[derive(Debug, Error)]
pub enum AcceptedWorkSinkError {
    #[error("Gate Authority delivery is unavailable")]
    Unavailable,
}

#[derive(Debug, Error)]
pub enum WorkSessionDisconnectSinkError {
    #[error("Gate Authority disconnect notification is unavailable")]
    Unavailable,
}
