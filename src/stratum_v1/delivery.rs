use async_trait::async_trait;
use thiserror::Error;

use super::{PostgresAcceptedWorkOutbox, StratumLeaseContext, StratumV1Error};
use crate::progress::{AcceptedWorkEvent, AcceptedWorkRefusal, WorkSessionId};

/// The longest wait between delivery attempts after repeated outages.
pub const MAX_DELIVERY_RETRY_SECONDS: u64 = 300;

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
        match sink
            .deliver(claimed.event().clone(), claimed.lease_context().clone())
            .await
        {
            Ok(()) => {
                self.outbox.acknowledge(&claimed, now_unix_seconds).await?;
                Ok(DeliveryOutcome::Acknowledged)
            }
            Err(AcceptedWorkSinkError::Refused(refusal)) => {
                self.outbox
                    .refuse(&claimed, refusal, now_unix_seconds)
                    .await?;
                Ok(DeliveryOutcome::Refused(refusal))
            }
            Err(AcceptedWorkSinkError::Unavailable) => {
                let retry_at = now_unix_seconds
                    .checked_add(retry_delay_seconds(claimed.delivery_attempts()))
                    .ok_or(StratumV1Error::InvalidSessionConfig)?;
                self.outbox
                    .defer(&claimed, now_unix_seconds, retry_at)
                    .await?;
                Ok(DeliveryOutcome::RetryableFailure)
            }
        }
    }
}

/// Exponential backoff after the `attempts`-th failed delivery: 1, 2, 4 … seconds.
pub fn retry_delay_seconds(attempts: u32) -> u64 {
    let exponent = attempts.saturating_sub(1).min(16);
    (1_u64 << exponent).min(MAX_DELIVERY_RETRY_SECONDS)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryOutcome {
    Empty,
    Acknowledged,
    /// The Authority will never credit the event; delivery stopped for good.
    Refused(AcceptedWorkRefusal),
    RetryableFailure,
}

#[derive(Debug, Error)]
pub enum AcceptedWorkSinkError {
    /// A network or server outage; delivery retries with backoff.
    #[error("Gate Authority delivery is unavailable")]
    Unavailable,
    /// A terminal refusal (ADR-0108); delivery records it and stops.
    #[error("Gate Authority refused the event: {}", .0.code())]
    Refused(AcceptedWorkRefusal),
}

#[derive(Debug, Error)]
pub enum WorkSessionDisconnectSinkError {
    #[error("Gate Authority disconnect notification is unavailable")]
    Unavailable,
}

#[cfg(test)]
mod tests {
    use super::{MAX_DELIVERY_RETRY_SECONDS, retry_delay_seconds};

    #[test]
    fn retry_delay_doubles_from_one_second() {
        // Act
        let delays: Vec<u64> = (1..=4).map(retry_delay_seconds).collect();

        // Assert
        assert_eq!(delays, vec![1, 2, 4, 8]);
    }

    #[test]
    fn retry_delay_is_capped() {
        // Act
        let delay = retry_delay_seconds(u32::MAX);

        // Assert
        assert_eq!(delay, MAX_DELIVERY_RETRY_SECONDS);
    }
}
