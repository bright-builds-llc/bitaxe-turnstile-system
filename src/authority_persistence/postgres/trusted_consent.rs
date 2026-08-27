use sqlx::{PgPool, Row as _, postgres::PgRow};

use crate::trusted_consent::{
    TrustedConsentBinding, TrustedConsentBindingInput, TrustedConsentCeremony,
    TrustedConsentCeremonyId, TrustedConsentOperationOwner,
};

use super::super::{
    AuthorityPersistenceError, ReserveTrustedConsentCeremony, TrustedConsentCeremonyRecord,
    TrustedConsentReservation, TrustedConsentVerificationClaim,
};

pub(super) async fn maybe_by_binding(
    pool: &PgPool,
    binding: &TrustedConsentBinding,
) -> Result<Option<TrustedConsentCeremonyRecord>, AuthorityPersistenceError> {
    let maybe_row = sqlx::query(
        "SELECT * FROM gate_authority.trusted_consent_ceremonies
         WHERE challenge_id = $1
           AND pool_offer_set_signature_sha256 = $2
           AND reason = $3
           AND authority_origin = $4",
    )
    .bind(binding.challenge_id())
    .bind(binding.pool_offer_set_signature_sha256())
    .bind(binding.reason().as_str())
    .bind(binding.authority_origin())
    .fetch_optional(pool)
    .await?;
    maybe_row.map(|row| record(&row)).transpose()
}

pub(super) async fn reserve(
    pool: &PgPool,
    input: ReserveTrustedConsentCeremony<'_>,
) -> Result<TrustedConsentReservation, AuthorityPersistenceError> {
    let ceremony = input.ceremony;
    let binding = ceremony.binding();
    let maybe_row = sqlx::query(include_str!("queries/reserve_trusted_consent_ceremony.sql"))
        .bind(ceremony.ceremony_id().as_str())
        .bind(binding.challenge_id())
        .bind(binding.disclosure_digest_sha256())
        .bind(binding.pool_offer_set_signature_sha256())
        .bind(binding.reason().as_str())
        .bind(binding.authority_origin())
        .bind(to_i64(binding.challenge_expires_at_unix_seconds())?)
        .bind(to_i64(ceremony.created_at_unix_seconds())?)
        .bind(to_i64(ceremony.expires_at_unix_seconds())?)
        .bind(input.operation_owner.as_uuid())
        .bind(to_i64(input.lease_expires_at_unix_seconds)?)
        .fetch_optional(pool)
        .await?;
    if maybe_row.is_some() {
        return Ok(TrustedConsentReservation::Claimed);
    }
    if let Some(existing) = maybe_by_binding(pool, binding).await? {
        if matches!(existing, TrustedConsentCeremonyRecord::Starting { .. }) {
            return Ok(TrustedConsentReservation::InProgress);
        }
        return Ok(TrustedConsentReservation::Existing(Box::new(existing)));
    }
    Err(AuthorityPersistenceError::TrustedConsentChallengeUnavailable)
}

pub(super) async fn initialize(
    pool: &PgPool,
    ceremony_id: &TrustedConsentCeremonyId,
    operation_owner: TrustedConsentOperationOwner,
    creation_options: &serde_json::Value,
    registration_state: &serde_json::Value,
    initialized_at_unix_seconds: u64,
) -> Result<TrustedConsentCeremonyRecord, AuthorityPersistenceError> {
    let maybe_row = sqlx::query(include_str!(
        "queries/initialize_trusted_consent_ceremony.sql"
    ))
    .bind(ceremony_id.as_str())
    .bind(operation_owner.as_uuid())
    .bind(creation_options)
    .bind(registration_state)
    .bind(to_i64(initialized_at_unix_seconds)?)
    .fetch_optional(pool)
    .await?;
    if let Some(row) = maybe_row {
        return record(&row);
    }
    abandon(pool, ceremony_id, operation_owner).await?;
    Err(AuthorityPersistenceError::TrustedConsentChallengeUnavailable)
}

pub(super) async fn abandon(
    pool: &PgPool,
    ceremony_id: &TrustedConsentCeremonyId,
    operation_owner: TrustedConsentOperationOwner,
) -> Result<(), AuthorityPersistenceError> {
    sqlx::query(
        "DELETE FROM gate_authority.trusted_consent_ceremonies
         WHERE ceremony_id = $1 AND status = 'starting'
           AND operation_owner = $2",
    )
    .bind(ceremony_id.as_str())
    .bind(operation_owner.as_uuid())
    .execute(pool)
    .await?;
    Ok(())
}

pub(super) async fn by_id(
    pool: &PgPool,
    ceremony_id: &TrustedConsentCeremonyId,
) -> Result<TrustedConsentCeremonyRecord, AuthorityPersistenceError> {
    let maybe_row = sqlx::query(
        "SELECT * FROM gate_authority.trusted_consent_ceremonies WHERE ceremony_id = $1",
    )
    .bind(ceremony_id.as_str())
    .fetch_optional(pool)
    .await?;
    let Some(row) = maybe_row else {
        return Err(AuthorityPersistenceError::UnknownTrustedConsentCeremony);
    };
    record(&row)
}

pub(super) async fn complete(
    pool: &PgPool,
    ceremony_id: &TrustedConsentCeremonyId,
    operation_owner: TrustedConsentOperationOwner,
    verified_at_unix_seconds: u64,
) -> Result<TrustedConsentCeremonyRecord, AuthorityPersistenceError> {
    let maybe_row = sqlx::query(include_str!(
        "queries/complete_trusted_consent_ceremony.sql"
    ))
    .bind(ceremony_id.as_str())
    .bind(operation_owner.as_uuid())
    .bind(to_i64(verified_at_unix_seconds)?)
    .fetch_optional(pool)
    .await?;
    if let Some(row) = maybe_row {
        return record(&row);
    }
    sqlx::query(
        "UPDATE gate_authority.trusted_consent_ceremonies
         SET status = 'failed', failed_at_unix_seconds = $3,
             operation_owner = NULL, operation_lease_expires_at_unix_seconds = NULL,
             creation_options = NULL, registration_state = NULL
         WHERE ceremony_id = $1 AND status = 'verifying'
           AND operation_owner = $2",
    )
    .bind(ceremony_id.as_str())
    .bind(operation_owner.as_uuid())
    .bind(to_i64(verified_at_unix_seconds)?)
    .execute(pool)
    .await?;
    Err(AuthorityPersistenceError::LostTrustedConsentVerificationLease)
}

pub(super) async fn claim_verification(
    pool: &PgPool,
    ceremony_id: &TrustedConsentCeremonyId,
    operation_owner: TrustedConsentOperationOwner,
    now_unix_seconds: u64,
    lease_expires_at_unix_seconds: u64,
) -> Result<TrustedConsentVerificationClaim, AuthorityPersistenceError> {
    let maybe_failed = sqlx::query(
        "UPDATE gate_authority.trusted_consent_ceremonies
         SET status = 'failed', failed_at_unix_seconds = $2,
             operation_owner = NULL, operation_lease_expires_at_unix_seconds = NULL,
             creation_options = NULL, registration_state = NULL
         WHERE ceremony_id = $1 AND status = 'verifying'
           AND operation_lease_expires_at_unix_seconds <= $2
         RETURNING *",
    )
    .bind(ceremony_id.as_str())
    .bind(to_i64(now_unix_seconds)?)
    .fetch_optional(pool)
    .await?;
    if maybe_failed.is_some() {
        return Ok(TrustedConsentVerificationClaim::Failed);
    }
    let maybe_row = sqlx::query(
        "UPDATE gate_authority.trusted_consent_ceremonies
         SET status = 'verifying', operation_owner = $2,
             operation_lease_expires_at_unix_seconds = $3
         WHERE ceremony_id = $1 AND status = 'pending'
         RETURNING *",
    )
    .bind(ceremony_id.as_str())
    .bind(operation_owner.as_uuid())
    .bind(to_i64(lease_expires_at_unix_seconds)?)
    .fetch_optional(pool)
    .await?;
    if let Some(row) = maybe_row {
        return Ok(TrustedConsentVerificationClaim::Claimed(record(&row)?));
    }
    let existing = by_id(pool, ceremony_id).await?;
    match existing {
        record @ TrustedConsentCeremonyRecord::Verified { .. } => {
            Ok(TrustedConsentVerificationClaim::Verified(record))
        }
        TrustedConsentCeremonyRecord::Failed { .. } => Ok(TrustedConsentVerificationClaim::Failed),
        TrustedConsentCeremonyRecord::Starting { .. }
        | TrustedConsentCeremonyRecord::Pending { .. }
        | TrustedConsentCeremonyRecord::Verifying { .. } => {
            Ok(TrustedConsentVerificationClaim::InProgress)
        }
    }
}

pub(super) async fn fail(
    pool: &PgPool,
    ceremony_id: &TrustedConsentCeremonyId,
    operation_owner: TrustedConsentOperationOwner,
    failed_at_unix_seconds: u64,
) -> Result<TrustedConsentCeremonyRecord, AuthorityPersistenceError> {
    let maybe_row = sqlx::query(
        "UPDATE gate_authority.trusted_consent_ceremonies
         SET status = 'failed', failed_at_unix_seconds = $3,
             operation_owner = NULL, operation_lease_expires_at_unix_seconds = NULL,
             creation_options = NULL, registration_state = NULL
         WHERE ceremony_id = $1 AND status = 'verifying'
           AND operation_owner = $2
         RETURNING *",
    )
    .bind(ceremony_id.as_str())
    .bind(operation_owner.as_uuid())
    .bind(to_i64(failed_at_unix_seconds)?)
    .fetch_optional(pool)
    .await?;
    let Some(row) = maybe_row else {
        return Err(AuthorityPersistenceError::LostTrustedConsentVerificationLease);
    };
    record(&row)
}

pub(super) async fn persist_receipt(
    pool: &PgPool,
    ceremony_id: &TrustedConsentCeremonyId,
    compact_receipt: &str,
    issued_at_unix_seconds: u64,
    expires_at_unix_seconds: u64,
) -> Result<String, AuthorityPersistenceError> {
    let maybe_persisted_receipt = sqlx::query_scalar::<_, String>(
        "UPDATE gate_authority.trusted_consent_ceremonies
         SET trusted_consent_receipt = COALESCE(trusted_consent_receipt, $2),
             receipt_issued_at_unix_seconds = COALESCE(receipt_issued_at_unix_seconds, $3),
             receipt_expires_at_unix_seconds = COALESCE(receipt_expires_at_unix_seconds, $4)
         WHERE ceremony_id = $1 AND status = 'verified'
           AND (trusted_consent_receipt IS NULL
                OR (trusted_consent_receipt = $2
                    AND receipt_issued_at_unix_seconds = $3
                    AND receipt_expires_at_unix_seconds = $4))
         RETURNING trusted_consent_receipt",
    )
    .bind(ceremony_id.as_str())
    .bind(compact_receipt)
    .bind(to_i64(issued_at_unix_seconds)?)
    .bind(to_i64(expires_at_unix_seconds)?)
    .fetch_optional(pool)
    .await?;
    if let Some(receipt) = maybe_persisted_receipt {
        return Ok(receipt);
    }
    maybe_receipt(pool, ceremony_id)
        .await?
        .ok_or(AuthorityPersistenceError::InvalidPersistedData)
}

pub(super) async fn maybe_receipt(
    pool: &PgPool,
    ceremony_id: &TrustedConsentCeremonyId,
) -> Result<Option<String>, AuthorityPersistenceError> {
    Ok(sqlx::query_scalar::<_, String>(
        "SELECT trusted_consent_receipt
         FROM gate_authority.trusted_consent_ceremonies
         WHERE ceremony_id = $1 AND status = 'verified'
           AND trusted_consent_receipt IS NOT NULL",
    )
    .bind(ceremony_id.as_str())
    .fetch_optional(pool)
    .await?)
}

pub(super) async fn retire_expired(
    pool: &PgPool,
    now_unix_seconds: u64,
) -> Result<u64, AuthorityPersistenceError> {
    let deleted = sqlx::query(
        "DELETE FROM gate_authority.trusted_consent_ceremonies
         WHERE ceremony_id IN (
             SELECT ceremony_id
             FROM gate_authority.trusted_consent_ceremonies
             WHERE status = 'starting'
               AND operation_lease_expires_at_unix_seconds <= $1
             ORDER BY operation_lease_expires_at_unix_seconds, ceremony_id
             LIMIT 100
             FOR UPDATE SKIP LOCKED
         )",
    )
    .bind(to_i64(now_unix_seconds)?)
    .execute(pool)
    .await?
    .rows_affected();
    let result = sqlx::query(
        "WITH retired AS (
             SELECT ceremony_id
             FROM gate_authority.trusted_consent_ceremonies
             WHERE (status = 'pending' AND expires_at_unix_seconds <= $1)
                OR (status = 'verifying' AND operation_lease_expires_at_unix_seconds <= $1)
             ORDER BY CASE status
                 WHEN 'pending' THEN expires_at_unix_seconds
                 ELSE operation_lease_expires_at_unix_seconds
             END, ceremony_id
             LIMIT 100
             FOR UPDATE SKIP LOCKED
         )
         UPDATE gate_authority.trusted_consent_ceremonies AS ceremony
         SET status = 'failed', failed_at_unix_seconds = $1,
             operation_owner = NULL, operation_lease_expires_at_unix_seconds = NULL,
             creation_options = NULL, registration_state = NULL
         FROM retired
         WHERE ceremony.ceremony_id = retired.ceremony_id",
    )
    .bind(to_i64(now_unix_seconds)?)
    .execute(pool)
    .await?;
    Ok(deleted.saturating_add(result.rows_affected()))
}

fn record(row: &PgRow) -> Result<TrustedConsentCeremonyRecord, AuthorityPersistenceError> {
    let binding = TrustedConsentBinding::try_from(TrustedConsentBindingInput {
        challenge_id: row.try_get("challenge_id")?,
        disclosure_digest_sha256: row.try_get("disclosure_digest_sha256")?,
        pool_offer_set_signature_sha256: row.try_get("pool_offer_set_signature_sha256")?,
        reason: row.try_get("reason")?,
        authority_origin: row.try_get("authority_origin")?,
        challenge_expires_at_unix_seconds: to_u64(
            row.try_get("challenge_expires_at_unix_seconds")?,
        )?,
    })
    .map_err(|_| AuthorityPersistenceError::InvalidPersistedData)?;
    let ceremony_id = TrustedConsentCeremonyId::try_from(row.try_get::<String, _>("ceremony_id")?)
        .map_err(|_| AuthorityPersistenceError::InvalidPersistedData)?;
    let created_at = to_u64(row.try_get("created_at_unix_seconds")?)?;
    let expires_at = to_u64(row.try_get("expires_at_unix_seconds")?)?;
    let ceremony = TrustedConsentCeremony::pending(ceremony_id, binding, created_at, expires_at)
        .map_err(|_| AuthorityPersistenceError::InvalidPersistedData)?;
    let status: String = row.try_get("status")?;
    let maybe_creation_options: Option<serde_json::Value> = row.try_get("creation_options")?;
    let maybe_registration_state: Option<serde_json::Value> = row.try_get("registration_state")?;
    match status.as_str() {
        "starting" if maybe_creation_options.is_none() && maybe_registration_state.is_none() => {
            Ok(TrustedConsentCeremonyRecord::Starting { ceremony })
        }
        "pending" | "verifying" => {
            let (Some(creation_options), Some(registration_state)) =
                (maybe_creation_options, maybe_registration_state)
            else {
                return Err(AuthorityPersistenceError::InvalidPersistedData);
            };
            if status == "pending" {
                Ok(TrustedConsentCeremonyRecord::Pending {
                    ceremony,
                    creation_options,
                    registration_state,
                })
            } else {
                Ok(TrustedConsentCeremonyRecord::Verifying {
                    ceremony,
                    creation_options,
                    registration_state,
                })
            }
        }
        "verified" => {
            if maybe_creation_options.is_some() || maybe_registration_state.is_some() {
                return Err(AuthorityPersistenceError::InvalidPersistedData);
            }
            let verified_at = to_u64(
                row.try_get::<Option<i64>, _>("verified_at_unix_seconds")?
                    .ok_or(AuthorityPersistenceError::InvalidPersistedData)?,
            )?;
            let ceremony = ceremony
                .verify(verified_at)
                .map_err(|_| AuthorityPersistenceError::InvalidPersistedData)?;
            Ok(TrustedConsentCeremonyRecord::Verified { ceremony })
        }
        "failed" => {
            if maybe_creation_options.is_some() || maybe_registration_state.is_some() {
                return Err(AuthorityPersistenceError::InvalidPersistedData);
            }
            let failed_at = to_u64(
                row.try_get::<Option<i64>, _>("failed_at_unix_seconds")?
                    .ok_or(AuthorityPersistenceError::InvalidPersistedData)?,
            )?;
            let ceremony = ceremony
                .fail(failed_at)
                .map_err(|_| AuthorityPersistenceError::InvalidPersistedData)?;
            Ok(TrustedConsentCeremonyRecord::Failed { ceremony })
        }
        _ => Err(AuthorityPersistenceError::InvalidPersistedData),
    }
}

fn to_i64(value: u64) -> Result<i64, AuthorityPersistenceError> {
    i64::try_from(value).map_err(|_| AuthorityPersistenceError::InvalidPersistedData)
}

fn to_u64(value: i64) -> Result<u64, AuthorityPersistenceError> {
    u64::try_from(value).map_err(|_| AuthorityPersistenceError::InvalidPersistedData)
}
