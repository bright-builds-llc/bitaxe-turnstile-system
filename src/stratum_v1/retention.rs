use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sqlx::PgPool;

use super::StratumV1Error;
use crate::governance::HOSTED_OPERATIONAL_RETENTION_SECONDS;

const MAXIMUM_RETENTION_BATCH_ROWS: u64 = 1_000;

/// Counts returned by one context-local Pool Adapter retirement batch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct PoolAdapterRetentionCounts {
    pub connections: u64,
    pub sessions: u64,
    pub settled_events: u64,
}

impl PoolAdapterRetentionCounts {
    /// True when no table has a row to count.
    pub const fn is_empty(&self) -> bool {
        self.connections == 0 && self.sessions == 0 && self.settled_events == 0
    }

    const fn plus(self, other: Self) -> Self {
        Self {
            connections: self.connections + other.connections,
            sessions: self.sessions + other.sessions,
            settled_events: self.settled_events + other.settled_events,
        }
    }
}

/// Context-local cleanup seam for expired Pool Adapter operational records.
#[derive(Clone)]
pub struct PostgresPoolAdapterRetention {
    pool: PgPool,
}

impl PostgresPoolAdapterRetention {
    pub async fn connect(database_url: &str) -> Result<Self, StratumV1Error> {
        let pool = PgPool::connect(database_url).await?;
        sqlx::migrate!("./migrations/pool_adapter")
            .run(&pool)
            .await?;
        Ok(Self { pool })
    }

    /// Counts what a full run with this instant and period would delete, changing nothing.
    pub async fn count_expired(
        &self,
        as_of_unix_seconds: u64,
        retention_seconds: u64,
    ) -> Result<PoolAdapterRetentionCounts, StratumV1Error> {
        let cutoff = retention_cutoff(as_of_unix_seconds, retention_seconds)?;
        let (connections, sessions, settled_events) = sqlx::query_as::<_, (i64, i64, i64)>(
            "SELECT
                 (SELECT COUNT(*)
                  FROM pool_adapter.stratum_connections AS connection
                  LEFT JOIN pool_adapter.stratum_sessions AS session
                    ON session.session_id = connection.session_id
                  WHERE (
                      connection.session_id IS NULL
                      AND connection.reserved_at_unix_seconds <= $1
                  ) OR session.expires_at_unix_seconds <= $1),
                 (SELECT COUNT(*) FROM pool_adapter.stratum_sessions
                  WHERE expires_at_unix_seconds <= $1),
                 (SELECT COUNT(*) FROM pool_adapter.accepted_work_outbox
                  WHERE delivery_state IN ('acknowledged', 'refused')
                    AND acknowledged_at_unix_seconds <= $1)",
        )
        .bind(cutoff)
        .fetch_one(&self.pool)
        .await?;
        Ok(PoolAdapterRetentionCounts {
            connections: row_count(connections)?,
            sessions: row_count(sessions)?,
            settled_events: row_count(settled_events)?,
        })
    }

    /// Runs batches of `retire` until one deletes nothing, returning the totals.
    pub async fn retire_until_done(
        &self,
        as_of_unix_seconds: u64,
        retention_seconds: u64,
        maximum_rows_per_table: u64,
    ) -> Result<PoolAdapterRetentionCounts, StratumV1Error> {
        let mut totals = PoolAdapterRetentionCounts::default();
        loop {
            let batch = self
                .retire(
                    as_of_unix_seconds,
                    retention_seconds,
                    maximum_rows_per_table,
                )
                .await?;
            if batch.is_empty() {
                return Ok(totals);
            }
            totals = totals.plus(batch);
        }
    }

    /// Deletes only records beyond the hosted operational floor, skipping rows another
    /// transaction holds, so an overlapping run never waits on this one.
    pub async fn retire(
        &self,
        as_of_unix_seconds: u64,
        retention_seconds: u64,
        maximum_rows_per_table: u64,
    ) -> Result<PoolAdapterRetentionCounts, StratumV1Error> {
        if maximum_rows_per_table == 0 || maximum_rows_per_table > MAXIMUM_RETENTION_BATCH_ROWS {
            return Err(StratumV1Error::InvalidRetentionPolicy);
        }
        let cutoff = retention_cutoff(as_of_unix_seconds, retention_seconds)?;
        let limit = i64::try_from(maximum_rows_per_table)
            .map_err(|_| StratumV1Error::InvalidRetentionPolicy)?;
        let mut transaction = self.pool.begin().await?;
        let connections = sqlx::query(
            "WITH eligible AS (
                 SELECT connection.connection_id
                 FROM pool_adapter.stratum_connections AS connection
                 LEFT JOIN pool_adapter.stratum_sessions AS session
                   ON session.session_id = connection.session_id
                 WHERE (
                     connection.session_id IS NULL
                     AND connection.reserved_at_unix_seconds <= $1
                 ) OR session.expires_at_unix_seconds <= $1
                 ORDER BY connection.reserved_at_unix_seconds, connection.connection_id
                 LIMIT $2
                 FOR UPDATE OF connection SKIP LOCKED
             )
             DELETE FROM pool_adapter.stratum_connections AS connection
             USING eligible
             WHERE connection.connection_id = eligible.connection_id",
        )
        .bind(cutoff)
        .bind(limit)
        .execute(&mut *transaction)
        .await?
        .rows_affected();
        let sessions = sqlx::query(
            "WITH eligible AS (
                 SELECT session.session_id
                 FROM pool_adapter.stratum_sessions AS session
                 WHERE session.expires_at_unix_seconds <= $1
                   AND NOT EXISTS (
                       SELECT 1 FROM pool_adapter.stratum_connections AS connection
                       WHERE connection.session_id = session.session_id
                   )
                 ORDER BY session.expires_at_unix_seconds, session.session_id
                 LIMIT $2
                 FOR UPDATE OF session SKIP LOCKED
             )
             DELETE FROM pool_adapter.stratum_sessions AS session
             USING eligible
             WHERE session.session_id = eligible.session_id",
        )
        .bind(cutoff)
        .bind(limit)
        .execute(&mut *transaction)
        .await?
        .rows_affected();
        let settled_events = sqlx::query(
            "WITH eligible AS (
                 SELECT event_id FROM pool_adapter.accepted_work_outbox
                 WHERE delivery_state IN ('acknowledged', 'refused')
                   AND acknowledged_at_unix_seconds <= $1
                 ORDER BY acknowledged_at_unix_seconds, event_id
                 LIMIT $2
                 FOR UPDATE SKIP LOCKED
             )
             DELETE FROM pool_adapter.accepted_work_outbox AS event
             USING eligible
             WHERE event.event_id = eligible.event_id",
        )
        .bind(cutoff)
        .bind(limit)
        .execute(&mut *transaction)
        .await?
        .rows_affected();
        transaction.commit().await?;
        Ok(PoolAdapterRetentionCounts {
            connections,
            sessions,
            settled_events,
        })
    }
}

/// The cutoff instant for a policy, refusing a future instant or a period under the floor.
fn retention_cutoff(
    as_of_unix_seconds: u64,
    retention_seconds: u64,
) -> Result<i64, StratumV1Error> {
    let trusted_now_unix_seconds = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    if as_of_unix_seconds > trusted_now_unix_seconds
        || retention_seconds < HOSTED_OPERATIONAL_RETENTION_SECONDS
    {
        return Err(StratumV1Error::InvalidRetentionPolicy);
    }
    let cutoff = as_of_unix_seconds
        .checked_sub(retention_seconds)
        .ok_or(StratumV1Error::InvalidRetentionPolicy)?;
    i64::try_from(cutoff).map_err(|_| StratumV1Error::InvalidRetentionPolicy)
}

fn row_count(count: i64) -> Result<u64, StratumV1Error> {
    u64::try_from(count).map_err(|_| StratumV1Error::InvalidRetentionPolicy)
}
