use sqlx::{PgPool, Row as _};

use super::{StratumLeaseContext, StratumV1Error};
use crate::progress::{
    AcceptedWorkEvent, AcceptedWorkEventId, AcceptedWorkEventInput, NetworkTargetOutcome,
    ReceiptTime, ShareFingerprint, WorkSessionId,
};

/// Context-local durable outbox for at-least-once Gate Authority delivery.
#[derive(Clone)]
pub struct PostgresAcceptedWorkOutbox {
    pool: PgPool,
}

impl PostgresAcceptedWorkOutbox {
    pub async fn connect(database_url: &str) -> Result<Self, StratumV1Error> {
        let pool = PgPool::connect(database_url).await?;
        sqlx::migrate!("./migrations/pool_adapter")
            .run(&pool)
            .await?;
        Ok(Self { pool })
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }

    pub async fn persist(
        &self,
        event: &AcceptedWorkEvent,
        lease_context: &StratumLeaseContext,
        worker_response: &str,
    ) -> Result<PersistedAcceptedWork, StratumV1Error> {
        if !valid_accepted_response(worker_response) {
            return Err(StratumV1Error::InvalidFrame);
        }
        let mut transaction = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO pool_adapter.accepted_work_outbox (
                 event_id, session_id, lease_id, continuity_id,
                 last_monotonic_milliseconds, renew_at_monotonic_milliseconds,
                 lease_expires_at_monotonic_milliseconds, assigned_target,
                 received_at_unix_seconds, share_fingerprint, network_target_outcome,
                 worker_response
             ) VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT (event_id) DO NOTHING",
        )
        .bind(event.event_id().as_str())
        .bind(event.work_session_id().as_str())
        .bind(lease_context.lease_id())
        .bind(lease_context.continuity_id())
        .bind(to_i64(lease_context.last_monotonic_milliseconds())?)
        .bind(to_i64(lease_context.renew_at_monotonic_milliseconds())?)
        .bind(to_i64(lease_context.expires_at_monotonic_milliseconds())?)
        .bind(event.assigned_target_be_bytes().as_slice())
        .bind(to_i64(event.received_at_unix_seconds())?)
        .bind(event.share_fingerprint().as_str())
        .bind(event.network_target_outcome().as_str())
        .bind(worker_response)
        .execute(&mut *transaction)
        .await?;
        let row = sqlx::query(
            "SELECT event_id, session_id, lease_id::text AS lease_id, continuity_id,
                    last_monotonic_milliseconds, renew_at_monotonic_milliseconds,
                    lease_expires_at_monotonic_milliseconds, assigned_target,
                    received_at_unix_seconds, share_fingerprint, network_target_outcome,
                    worker_response
             FROM pool_adapter.accepted_work_outbox WHERE event_id = $1",
        )
        .bind(event.event_id().as_str())
        .fetch_one(&mut *transaction)
        .await?;
        let persisted = event_from_row(&row)?;
        let persisted_lease_context = lease_context_from_row(&row)?;
        let persisted_response = row.try_get::<String, _>("worker_response")?;
        if !same_share_observation(&persisted, event)
            || !same_lease_identity(&persisted_lease_context, lease_context)
            || persisted_response != worker_response
        {
            return Err(StratumV1Error::ConflictingOutboxReplay);
        }
        transaction.commit().await?;
        Ok(PersistedAcceptedWork {
            event: persisted,
            lease_context: persisted_lease_context,
            worker_response: persisted_response,
        })
    }

    pub async fn claim_next(
        &self,
        worker_id: &str,
        now_unix_seconds: u64,
        lease_expires_at_unix_seconds: u64,
    ) -> Result<Option<ClaimedAcceptedWork>, StratumV1Error> {
        if !valid_delivery_worker(worker_id) || lease_expires_at_unix_seconds <= now_unix_seconds {
            return Err(StratumV1Error::InvalidSessionConfig);
        }
        let row = sqlx::query(
            "WITH candidate AS (
                 SELECT event_id
                 FROM pool_adapter.accepted_work_outbox
                 WHERE delivery_state = 'pending'
                   AND (
                       delivery_owner IS NULL
                       OR delivery_lease_expires_at_unix_seconds <= $2
                   )
                 ORDER BY received_at_unix_seconds, event_id
                 FOR UPDATE SKIP LOCKED
                 LIMIT 1
             )
             UPDATE pool_adapter.accepted_work_outbox AS event
             SET delivery_owner = $1,
                 delivery_lease_expires_at_unix_seconds = $3,
                 delivery_attempts = delivery_attempts + 1
             FROM candidate
             WHERE event.event_id = candidate.event_id
             RETURNING event.event_id, event.session_id,
                       event.lease_id::text AS lease_id, event.continuity_id,
                       event.last_monotonic_milliseconds,
                       event.renew_at_monotonic_milliseconds,
                       event.lease_expires_at_monotonic_milliseconds,
                       event.assigned_target, event.received_at_unix_seconds,
                       event.share_fingerprint, event.network_target_outcome,
                       event.worker_response",
        )
        .bind(worker_id)
        .bind(to_i64(now_unix_seconds)?)
        .bind(to_i64(lease_expires_at_unix_seconds)?)
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| {
            Ok(ClaimedAcceptedWork {
                event: event_from_row(&row)?,
                lease_context: lease_context_from_row(&row)?,
                worker_response: row.try_get("worker_response")?,
                delivery_owner: worker_id.to_owned(),
                lease_expires_at_unix_seconds,
            })
        })
        .transpose()
    }

    pub async fn acknowledge(
        &self,
        claimed: &ClaimedAcceptedWork,
        now_unix_seconds: u64,
    ) -> Result<(), StratumV1Error> {
        let result = sqlx::query(
            "UPDATE pool_adapter.accepted_work_outbox
             SET delivery_state = 'acknowledged',
                 acknowledged_at_unix_seconds = $3,
                 delivery_owner = NULL,
                 delivery_lease_expires_at_unix_seconds = NULL
             WHERE event_id = $1
               AND delivery_state = 'pending'
               AND delivery_owner = $2
               AND delivery_lease_expires_at_unix_seconds > $3",
        )
        .bind(claimed.event.event_id().as_str())
        .bind(&claimed.delivery_owner)
        .bind(to_i64(now_unix_seconds)?)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            return Err(StratumV1Error::LostDeliveryLease);
        }
        Ok(())
    }
}

/// Exact first durable representation of one accepted upstream response.
pub struct PersistedAcceptedWork {
    event: AcceptedWorkEvent,
    lease_context: StratumLeaseContext,
    worker_response: String,
}

impl PersistedAcceptedWork {
    pub fn event(&self) -> &AcceptedWorkEvent {
        &self.event
    }

    pub fn worker_response(&self) -> &str {
        &self.worker_response
    }

    pub fn lease_context(&self) -> &StratumLeaseContext {
        &self.lease_context
    }
}

/// One exact Accepted Work Event held under a recoverable delivery lease.
pub struct ClaimedAcceptedWork {
    event: AcceptedWorkEvent,
    lease_context: StratumLeaseContext,
    worker_response: String,
    delivery_owner: String,
    lease_expires_at_unix_seconds: u64,
}

impl ClaimedAcceptedWork {
    pub fn event(&self) -> &AcceptedWorkEvent {
        &self.event
    }

    pub fn worker_response(&self) -> &str {
        &self.worker_response
    }

    pub fn lease_context(&self) -> &StratumLeaseContext {
        &self.lease_context
    }

    pub fn lease_expires_at_unix_seconds(&self) -> u64 {
        self.lease_expires_at_unix_seconds
    }
}

fn event_from_row(row: &sqlx::postgres::PgRow) -> Result<AcceptedWorkEvent, StratumV1Error> {
    let target = row.try_get::<Vec<u8>, _>("assigned_target")?;
    Ok(AcceptedWorkEvent::try_from(AcceptedWorkEventInput {
        event_id: AcceptedWorkEventId::try_from(row.try_get::<String, _>("event_id")?)?,
        work_session_id: WorkSessionId::try_from(row.try_get::<String, _>("session_id")?)?,
        assigned_target: target
            .try_into()
            .map_err(|_| StratumV1Error::ConflictingOutboxReplay)?,
        received_at: ReceiptTime::try_from(to_u64(row.try_get("received_at_unix_seconds")?)?)?,
        share_fingerprint: ShareFingerprint::try_from(
            row.try_get::<String, _>("share_fingerprint")?,
        )?,
        network_target_outcome: NetworkTargetOutcome::parse(
            &row.try_get::<String, _>("network_target_outcome")?,
        )?,
        maybe_worker_report: None,
    })?)
}

fn lease_context_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<StratumLeaseContext, StratumV1Error> {
    StratumLeaseContext::new(
        row.try_get("lease_id")?,
        row.try_get("continuity_id")?,
        to_u64(row.try_get("last_monotonic_milliseconds")?)?,
        to_u64(row.try_get("renew_at_monotonic_milliseconds")?)?,
        to_u64(row.try_get("lease_expires_at_monotonic_milliseconds")?)?,
    )
}

fn valid_accepted_response(value: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(value)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .is_some_and(|response| {
            response.get("result").and_then(|value| value.as_bool()) == Some(true)
        })
}

fn same_share_observation(left: &AcceptedWorkEvent, right: &AcceptedWorkEvent) -> bool {
    left.work_session_id() == right.work_session_id()
        && left.assigned_target_be_bytes() == right.assigned_target_be_bytes()
        && left.share_fingerprint() == right.share_fingerprint()
        && left.network_target_outcome() == right.network_target_outcome()
}

fn same_lease_identity(left: &StratumLeaseContext, right: &StratumLeaseContext) -> bool {
    left.lease_id() == right.lease_id() && left.continuity_id() == right.continuity_id()
}

fn valid_delivery_worker(value: &str) -> bool {
    value
        .strip_prefix("delivery_worker_")
        .is_some_and(|suffix| {
            !suffix.is_empty()
                && suffix.len() <= 128
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        })
}

fn to_i64(value: u64) -> Result<i64, StratumV1Error> {
    i64::try_from(value).map_err(|_| StratumV1Error::InvalidSessionConfig)
}

fn to_u64(value: i64) -> Result<u64, StratumV1Error> {
    u64::try_from(value).map_err(|_| StratumV1Error::ConflictingOutboxReplay)
}
