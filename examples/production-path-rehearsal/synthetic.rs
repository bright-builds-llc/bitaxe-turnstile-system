//! The rehearsal's one synthetic share and its delivery evidence.
//!
//! A CPU miner on regtest earns about one hash of credit per share, so the
//! rehearsal crosses the Work Requirement with one hard-target Accepted Work
//! Event (ADR-0109's Ticket 06 decision). It enters the Pool Adapter outbox like a
//! real share and reaches the Authority through the same delivery sink. Only this
//! example builds it; `tests/rehearsal_isolation.rs` checks that nothing else can.

use std::error::Error;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use bwg_core::{
    progress::{
        AcceptedWorkEvent, AcceptedWorkEventId, AcceptedWorkEventInput, NetworkTargetOutcome,
        ReceiptTime, ShareFingerprint, WorkSessionId,
    },
    stratum_v1::{PostgresAcceptedWorkOutbox, StratumLeaseContext},
};
use serde_json::{Value, json};
use sqlx::{PgPool, Row as _};
use uuid::Uuid;

pub(crate) type SyntheticResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

/// Prefix of every synthetic event and share identifier, so evidence can tell them apart.
pub(crate) const SYNTHETIC_SHARE_MARKER: &str = "rehearsal_synthetic_share";
const ACCEPTED_RESPONSE: &str = r#"{"id":0,"result":true,"error":null}"#;

/// Derives the one claimant Work Session of a challenge, as the Authority does.
fn claimant_session_id(challenge_id: &str) -> String {
    let mut input = b"BWG/0.1 claimant Work Session\0".to_vec();
    input.extend_from_slice(challenge_id.as_bytes());
    let digest = ring::digest::digest(&ring::digest::SHA256, &input);
    format!("session_{}", URL_SAFE_NO_PAD.encode(digest.as_ref()))
}

/// Queues one hard-target share read at the latest acknowledged real share's reading.
///
/// Returns `false` while the session has no acknowledged real share to follow.
pub(crate) async fn queue(
    pool: &PgPool,
    outbox: &PostgresAcceptedWorkOutbox,
    challenge_id: &str,
) -> SyntheticResult<bool> {
    let session_id = claimant_session_id(challenge_id);
    let maybe_row = sqlx::query(
        "SELECT lease_id::text AS lease_id, continuity_id, last_monotonic_milliseconds,
                renew_at_monotonic_milliseconds, lease_expires_at_monotonic_milliseconds
         FROM pool_adapter.accepted_work_outbox
         WHERE session_id = $1 AND delivery_state = 'acknowledged' AND event_id NOT LIKE $2
         ORDER BY last_monotonic_milliseconds DESC
         LIMIT 1",
    )
    .bind(&session_id)
    .bind(format!("event_{SYNTHETIC_SHARE_MARKER}%"))
    .fetch_optional(pool)
    .await?;
    let Some(row) = maybe_row else {
        return Ok(false);
    };
    let reading = |column: &str| -> SyntheticResult<u64> {
        Ok(u64::try_from(row.try_get::<i64, _>(column)?)?)
    };
    let lease_context = StratumLeaseContext::new(
        row.try_get("lease_id")?,
        row.try_get("continuity_id")?,
        reading("last_monotonic_milliseconds")?,
        reading("renew_at_monotonic_milliseconds")?,
        reading("lease_expires_at_monotonic_milliseconds")?,
    )?;
    let suffix = format!("{SYNTHETIC_SHARE_MARKER}_{}", Uuid::new_v4().simple());
    let received_at = crate::now_unix_seconds().ok_or("system clock is unavailable")?;
    let event = AcceptedWorkEvent::try_from(AcceptedWorkEventInput {
        event_id: AcceptedWorkEventId::try_from(format!("event_{suffix}"))?,
        work_session_id: WorkSessionId::try_from(session_id)?,
        assigned_target: hard_target(),
        received_at: ReceiptTime::try_from(received_at)?,
        share_fingerprint: ShareFingerprint::try_from(format!("share_{suffix}"))?,
        network_target_outcome: NetworkTargetOutcome::BelowNetworkTarget,
        maybe_worker_report: None,
    })?;
    outbox
        .persist(&event, &lease_context, ACCEPTED_RESPONSE)
        .await?;
    Ok(true)
}

/// A 2^208 target credits about 2^48 expected hashes, above every Action Policy.
fn hard_target() -> [u8; 32] {
    let mut target = [0xff_u8; 32];
    target[..6].fill(0);
    target
}

/// Summarizes how the session's shares were delivered, without any share contents.
pub(crate) async fn delivery_evidence(pool: &PgPool, challenge_id: &str) -> SyntheticResult<Value> {
    let session_id = claimant_session_id(challenge_id);
    let row = sqlx::query(
        "SELECT
             COUNT(*) FILTER (WHERE delivery_state = 'acknowledged' AND event_id NOT LIKE $2)
                 AS real_acknowledged,
             COUNT(*) FILTER (WHERE delivery_state = 'acknowledged' AND event_id LIKE $2)
                 AS synthetic_acknowledged,
             COUNT(*) FILTER (WHERE delivery_state = 'refused') AS refused,
             COUNT(*) FILTER (WHERE delivery_state NOT IN ('acknowledged', 'refused')) AS pending,
             COUNT(DISTINCT lease_expires_at_monotonic_milliseconds)
                 FILTER (WHERE delivery_state = 'acknowledged' AND event_id NOT LIKE $2)
                 AS acknowledged_lease_windows
         FROM pool_adapter.accepted_work_outbox
         WHERE session_id = $1",
    )
    .bind(&session_id)
    .bind(format!("event_{SYNTHETIC_SHARE_MARKER}%"))
    .fetch_one(pool)
    .await?;
    let refusals = sqlx::query(
        "SELECT refusal_reason, COUNT(*) AS count FROM pool_adapter.accepted_work_outbox
         WHERE session_id = $1 AND delivery_state = 'refused'
         GROUP BY refusal_reason ORDER BY refusal_reason",
    )
    .bind(&session_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|row| -> SyntheticResult<(String, Value)> {
        Ok((
            row.try_get::<String, _>("refusal_reason")?,
            json!(row.try_get::<i64, _>("count")?),
        ))
    })
    .collect::<SyntheticResult<serde_json::Map<_, _>>>()?;
    Ok(json!({
        "realAcknowledged": row.try_get::<i64, _>("real_acknowledged")?,
        "syntheticAcknowledged": row.try_get::<i64, _>("synthetic_acknowledged")?,
        "refused": row.try_get::<i64, _>("refused")?,
        "refusalReasons": refusals,
        "pending": row.try_get::<i64, _>("pending")?,
        "acknowledgedLeaseWindows": row.try_get::<i64, _>("acknowledged_lease_windows")?,
    }))
}
