use std::time::{SystemTime, UNIX_EPOCH};

use sqlx::PgPool;

use super::StratumV1Error;
use crate::governance::HOSTED_OPERATIONAL_RETENTION_SECONDS;

const MAXIMUM_RETENTION_BATCH_ROWS: u64 = 1_000;

/// Counts returned by one context-local Pool Adapter retirement batch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PoolAdapterRetentionCounts {
    pub connections: u64,
    pub sessions: u64,
    pub acknowledged_events: u64,
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

    /// Deletes only records beyond the hosted operational floor.
    pub async fn retire(
        &self,
        as_of_unix_seconds: u64,
        retention_seconds: u64,
        maximum_rows_per_table: u64,
    ) -> Result<PoolAdapterRetentionCounts, StratumV1Error> {
        let trusted_now_unix_seconds = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        if as_of_unix_seconds > trusted_now_unix_seconds
            || retention_seconds < HOSTED_OPERATIONAL_RETENTION_SECONDS
            || maximum_rows_per_table == 0
            || maximum_rows_per_table > MAXIMUM_RETENTION_BATCH_ROWS
        {
            return Err(StratumV1Error::InvalidRetentionPolicy);
        }
        let cutoff = as_of_unix_seconds
            .checked_sub(retention_seconds)
            .ok_or(StratumV1Error::InvalidRetentionPolicy)?;
        let cutoff = i64::try_from(cutoff).map_err(|_| StratumV1Error::InvalidRetentionPolicy)?;
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
        let acknowledged_events = sqlx::query(
            "WITH eligible AS (
                 SELECT event_id FROM pool_adapter.accepted_work_outbox
                 WHERE delivery_state = 'acknowledged'
                   AND acknowledged_at_unix_seconds <= $1
                 ORDER BY acknowledged_at_unix_seconds, event_id
                 LIMIT $2
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
            acknowledged_events,
        })
    }
}
