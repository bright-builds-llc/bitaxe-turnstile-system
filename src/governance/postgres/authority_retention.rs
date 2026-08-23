use sqlx::Row as _;
use uuid::Uuid;

use super::{PlannedItem, to_i64};
use crate::governance::{
    GovernanceContext, GovernanceError, GovernedRecordClass, PseudonymizationKey, RetentionPolicy,
    pseudonymize_record,
};

#[derive(Clone, Copy)]
enum AuthorityTerminalStatus {
    Issued,
    Failed,
    Expired,
}

impl AuthorityTerminalStatus {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Issued => "issued",
            Self::Failed => "failed",
            Self::Expired => "expired",
        }
    }
}

pub(super) async fn pseudonymize_authority_aggregate(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    context: GovernanceContext,
    item: &PlannedItem,
    as_of_unix_seconds: u64,
    policy: RetentionPolicy,
    key: &PseudonymizationKey,
) -> Result<u64, GovernanceError> {
    if context != GovernanceContext::GateAuthority
        || item.record_class != GovernedRecordClass::AuthorityOperational
    {
        return Err(GovernanceError::InvalidPersistedData);
    }
    let terminal_at = item
        .retention_floor_unix_seconds
        .checked_sub(policy.operational_retention_seconds())
        .ok_or(GovernanceError::InvalidPersistedData)?;
    let maybe_terminal = sqlx::query(include_str!(
        "../queries/select_authority_aggregate_for_retention.sql"
    ))
    .bind(&item.record_key)
    .bind(to_i64(terminal_at)?)
    .bind(to_i64(policy.operational_retention_seconds())?)
    .bind(to_i64(item.retention_floor_unix_seconds)?)
    .bind(to_i64(as_of_unix_seconds)?)
    .fetch_optional(&mut **transaction)
    .await?;
    let Some(terminal) = maybe_terminal else {
        return Ok(0);
    };
    let terminal_status =
        parse_terminal_status(&terminal.try_get::<String, _>("terminal_status")?)?;
    let delete_after = terminal_at
        .checked_add(policy.tombstone_retention_seconds())
        .ok_or(GovernanceError::InvalidPersistedData)?;
    let tombstone_id = Uuid::new_v4();
    let pseudonym = pseudonymize_record(
        key,
        GovernanceContext::GateAuthority,
        GovernedRecordClass::AuthorityOperational,
        &item.record_key,
    );
    sqlx::query(include_str!("../queries/insert_authority_tombstone.sql"))
        .bind(tombstone_id)
        .bind(pseudonym)
        .bind(terminal_status.as_str())
        .bind(to_i64(terminal_at)?)
        .bind(to_i64(as_of_unix_seconds)?)
        .bind(to_i64(delete_after)?)
        .execute(&mut **transaction)
        .await?;
    let deleted = sqlx::query(include_str!("../queries/delete_authority_aggregate.sql"))
        .bind(&item.record_key)
        .execute(&mut **transaction)
        .await?;
    Ok(deleted.rows_affected())
}

pub(super) async fn delete_authority_tombstone(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    context: GovernanceContext,
    item: &PlannedItem,
    as_of_unix_seconds: u64,
) -> Result<u64, GovernanceError> {
    if context != GovernanceContext::GateAuthority
        || item.record_class != GovernedRecordClass::AuthorityOperational
    {
        return Err(GovernanceError::InvalidPersistedData);
    }
    let tombstone_id =
        Uuid::parse_str(&item.record_key).map_err(|_| GovernanceError::InvalidPersistedData)?;
    let deleted = sqlx::query(include_str!("../queries/delete_authority_tombstone.sql"))
        .bind(tombstone_id)
        .bind(to_i64(item.retention_floor_unix_seconds)?)
        .bind(to_i64(as_of_unix_seconds)?)
        .execute(&mut **transaction)
        .await?;
    Ok(deleted.rows_affected())
}

pub(super) async fn delete_overdue_authority_aggregate(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    context: GovernanceContext,
    item: &PlannedItem,
    as_of_unix_seconds: u64,
    policy: RetentionPolicy,
) -> Result<u64, GovernanceError> {
    if context != GovernanceContext::GateAuthority
        || item.record_class != GovernedRecordClass::AuthorityOperational
    {
        return Err(GovernanceError::InvalidPersistedData);
    }
    let terminal_at = item
        .retention_floor_unix_seconds
        .checked_sub(policy.tombstone_retention_seconds())
        .ok_or(GovernanceError::InvalidPersistedData)?;
    let maybe_aggregate = sqlx::query(include_str!(
        "../queries/select_overdue_authority_aggregate.sql"
    ))
    .bind(&item.record_key)
    .bind(to_i64(terminal_at)?)
    .bind(to_i64(policy.tombstone_retention_seconds())?)
    .bind(to_i64(item.retention_floor_unix_seconds)?)
    .bind(to_i64(as_of_unix_seconds)?)
    .fetch_optional(&mut **transaction)
    .await?;
    let Some(_) = maybe_aggregate else {
        return Ok(0);
    };
    let deleted = sqlx::query(include_str!("../queries/delete_authority_aggregate.sql"))
        .bind(&item.record_key)
        .execute(&mut **transaction)
        .await?;
    Ok(deleted.rows_affected())
}

fn parse_terminal_status(value: &str) -> Result<AuthorityTerminalStatus, GovernanceError> {
    match value {
        "issued" => Ok(AuthorityTerminalStatus::Issued),
        "failed" => Ok(AuthorityTerminalStatus::Failed),
        "expired" => Ok(AuthorityTerminalStatus::Expired),
        _ => Err(GovernanceError::InvalidPersistedData),
    }
}
