use sqlx::Row as _;
use uuid::Uuid;

use super::{PlannedItem, to_i64, to_u64};
use crate::governance::{
    GovernanceContext, GovernanceError, GovernedRecordClass, PassRetentionMarker,
    PseudonymizationKey, RetentionFloors, RetentionPolicy, pass_retention_floors,
    pseudonymize_record, relying_retention_floors,
};

struct PassMarker {
    issuer: String,
    pass_id: String,
    consumed_at: u64,
    expires_at: u64,
}

struct RelyingAggregate {
    protected_action_type: String,
    action_policy: String,
    terminal_status: RelyingTerminalStatus,
    terminal_at: u64,
    public_lookup_expires_at: u64,
    pass_markers: Vec<PassMarker>,
}

struct NewTombstone<'a> {
    record_class: GovernedRecordClass,
    pseudonym: &'a str,
    terminal_status: &'a str,
    maybe_protected_action_type: Option<&'a str>,
    maybe_action_policy: Option<&'a str>,
    terminal_at: u64,
    pseudonymized_at: u64,
    delete_after: u64,
}

#[derive(Clone, Copy)]
enum RelyingTerminalStatus {
    Succeeded,
    Failed,
}

impl RelyingTerminalStatus {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
        }
    }
}

pub(super) async fn pseudonymize_reference_record(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    context: GovernanceContext,
    item: &PlannedItem,
    as_of_unix_seconds: u64,
    policy: RetentionPolicy,
    key: &PseudonymizationKey,
) -> Result<u64, GovernanceError> {
    if context != GovernanceContext::RelyingService {
        return Err(GovernanceError::InvalidPersistedData);
    }
    match item.record_class {
        GovernedRecordClass::PassConsumption => {
            pseudonymize_pass_consumption(transaction, item, as_of_unix_seconds, policy, key).await
        }
        GovernedRecordClass::RelyingServiceOperational => {
            pseudonymize_relying_aggregate(transaction, item, as_of_unix_seconds, policy, key).await
        }
        _ => Err(GovernanceError::InvalidPersistedData),
    }
}

pub(super) async fn delete_reference_tombstone(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    context: GovernanceContext,
    item: &PlannedItem,
    as_of_unix_seconds: u64,
) -> Result<u64, GovernanceError> {
    if context != GovernanceContext::RelyingService
        || !matches!(
            item.record_class,
            GovernedRecordClass::PassConsumption | GovernedRecordClass::RelyingServiceOperational
        )
    {
        return Err(GovernanceError::InvalidPersistedData);
    }
    let tombstone_id =
        Uuid::parse_str(&item.record_key).map_err(|_| GovernanceError::InvalidPersistedData)?;
    let deleted = sqlx::query(include_str!("../queries/delete_relying_tombstone.sql"))
        .bind(tombstone_id)
        .bind(item.record_class.as_str())
        .bind(to_i64(item.retention_floor_unix_seconds)?)
        .bind(to_i64(as_of_unix_seconds)?)
        .execute(&mut **transaction)
        .await?;
    Ok(deleted.rows_affected())
}

pub(super) async fn delete_overdue_reference_record(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    context: GovernanceContext,
    item: &PlannedItem,
    as_of_unix_seconds: u64,
    policy: RetentionPolicy,
) -> Result<u64, GovernanceError> {
    if context != GovernanceContext::RelyingService {
        return Err(GovernanceError::InvalidPersistedData);
    }
    if item.record_class == GovernedRecordClass::PassConsumption {
        return delete_overdue_pass_consumption(transaction, item, as_of_unix_seconds, policy)
            .await;
    }
    if item.record_class != GovernedRecordClass::RelyingServiceOperational {
        return Err(GovernanceError::InvalidPersistedData);
    }
    let Some(aggregate) = maybe_relying_aggregate(transaction, &item.record_key).await? else {
        return Ok(0);
    };
    let floors = aggregate_floors(&aggregate, policy)?;
    if floors.final_deletion != item.retention_floor_unix_seconds
        || floors.final_deletion > as_of_unix_seconds
    {
        return Ok(0);
    }
    delete_relying_aggregate(transaction, &item.record_key).await
}

async fn delete_overdue_pass_consumption(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    item: &PlannedItem,
    as_of_unix_seconds: u64,
    policy: RetentionPolicy,
) -> Result<u64, GovernanceError> {
    let (issuer, pass_id) = parse_pass_marker_key(&item.record_key)?;
    let maybe_row = sqlx::query(include_str!(
        "../queries/select_pass_consumption_for_retention.sql"
    ))
    .bind(&issuer)
    .bind(&pass_id)
    .fetch_optional(&mut **transaction)
    .await?;
    let Some(row) = maybe_row else {
        return Ok(0);
    };
    let marker = PassRetentionMarker {
        consumed_at: to_u64(row.try_get("consumed_at_unix_seconds")?)?,
        expires_at: to_u64(row.try_get("gate_pass_expires_at_unix_seconds")?)?,
    };
    let floors = pass_retention_floors(marker, policy)?;
    if floors.final_deletion != item.retention_floor_unix_seconds
        || floors.final_deletion > as_of_unix_seconds
    {
        return Ok(0);
    }
    let deleted = sqlx::query(include_str!("../queries/delete_pass_consumption.sql"))
        .bind(&issuer)
        .bind(&pass_id)
        .bind(to_i64(marker.consumed_at)?)
        .bind(to_i64(marker.expires_at)?)
        .execute(&mut **transaction)
        .await?;
    Ok(deleted.rows_affected())
}

async fn pseudonymize_relying_aggregate(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    item: &PlannedItem,
    as_of_unix_seconds: u64,
    policy: RetentionPolicy,
    key: &PseudonymizationKey,
) -> Result<u64, GovernanceError> {
    let Some(aggregate) = maybe_relying_aggregate(transaction, &item.record_key).await? else {
        return Ok(0);
    };
    let floors = aggregate_floors(&aggregate, policy)?;
    if floors.operational != item.retention_floor_unix_seconds
        || floors.operational > as_of_unix_seconds
    {
        return Ok(0);
    }
    for marker in &aggregate.pass_markers {
        insert_pass_tombstone(transaction, marker, as_of_unix_seconds, policy, key).await?;
    }
    let pseudonym = pseudonymize_record(
        key,
        GovernanceContext::RelyingService,
        GovernedRecordClass::RelyingServiceOperational,
        &item.record_key,
    );
    insert_tombstone(
        transaction,
        NewTombstone {
            record_class: GovernedRecordClass::RelyingServiceOperational,
            pseudonym: &pseudonym,
            terminal_status: aggregate.terminal_status.as_str(),
            maybe_protected_action_type: Some(&aggregate.protected_action_type),
            maybe_action_policy: Some(&aggregate.action_policy),
            terminal_at: aggregate.terminal_at,
            pseudonymized_at: as_of_unix_seconds,
            delete_after: floors.final_deletion,
        },
    )
    .await?;
    delete_relying_aggregate(transaction, &item.record_key).await
}

async fn pseudonymize_pass_consumption(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    item: &PlannedItem,
    as_of_unix_seconds: u64,
    policy: RetentionPolicy,
    key: &PseudonymizationKey,
) -> Result<u64, GovernanceError> {
    let (issuer, pass_id) = parse_pass_marker_key(&item.record_key)?;
    let maybe_row = sqlx::query(include_str!(
        "../queries/select_pass_consumption_for_retention.sql"
    ))
    .bind(&issuer)
    .bind(&pass_id)
    .fetch_optional(&mut **transaction)
    .await?;
    let Some(row) = maybe_row else {
        return Ok(0);
    };
    let marker = PassMarker {
        issuer,
        pass_id,
        consumed_at: to_u64(row.try_get("consumed_at_unix_seconds")?)?,
        expires_at: to_u64(row.try_get("gate_pass_expires_at_unix_seconds")?)?,
    };
    let floors = pass_retention_floors(marker.retention(), policy)?;
    if floors.operational != item.retention_floor_unix_seconds
        || floors.operational > as_of_unix_seconds
    {
        return Ok(0);
    }
    insert_pass_tombstone(transaction, &marker, as_of_unix_seconds, policy, key).await?;
    let deleted = sqlx::query(include_str!("../queries/delete_pass_consumption.sql"))
        .bind(&marker.issuer)
        .bind(&marker.pass_id)
        .bind(to_i64(marker.consumed_at)?)
        .bind(to_i64(marker.expires_at)?)
        .execute(&mut **transaction)
        .await?;
    Ok(deleted.rows_affected())
}

async fn maybe_relying_aggregate(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    redemption_id: &str,
) -> Result<Option<RelyingAggregate>, GovernanceError> {
    let maybe_row = sqlx::query(include_str!(
        "../queries/select_relying_aggregate_for_retention.sql"
    ))
    .bind(redemption_id)
    .fetch_optional(&mut **transaction)
    .await?;
    let Some(row) = maybe_row else {
        return Ok(None);
    };
    let pass_markers = sqlx::query(include_str!(
        "../queries/select_aggregate_pass_consumptions.sql"
    ))
    .bind(redemption_id)
    .fetch_all(&mut **transaction)
    .await?
    .into_iter()
    .map(|marker| {
        Ok(PassMarker {
            issuer: marker.try_get("issuer")?,
            pass_id: marker.try_get("pass_id")?,
            consumed_at: to_u64(marker.try_get("consumed_at_unix_seconds")?)?,
            expires_at: to_u64(marker.try_get("gate_pass_expires_at_unix_seconds")?)?,
        })
    })
    .collect::<Result<Vec<_>, GovernanceError>>()?;
    Ok(Some(RelyingAggregate {
        protected_action_type: row.try_get("protected_action_type")?,
        action_policy: row.try_get("action_policy")?,
        terminal_status: parse_terminal_status(&row.try_get::<String, _>("terminal_status")?)?,
        terminal_at: to_u64(row.try_get("terminal_at_unix_seconds")?)?,
        public_lookup_expires_at: to_u64(row.try_get("public_lookup_expires_at_unix_seconds")?)?,
        pass_markers,
    }))
}

fn aggregate_floors(
    aggregate: &RelyingAggregate,
    policy: RetentionPolicy,
) -> Result<RetentionFloors, GovernanceError> {
    let pass_markers = aggregate
        .pass_markers
        .iter()
        .map(PassMarker::retention)
        .collect::<Vec<_>>();
    relying_retention_floors(
        aggregate.terminal_at,
        aggregate.public_lookup_expires_at,
        &pass_markers,
        policy,
    )
}

async fn insert_pass_tombstone(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    marker: &PassMarker,
    pseudonymized_at: u64,
    policy: RetentionPolicy,
    key: &PseudonymizationKey,
) -> Result<(), GovernanceError> {
    let record_key = serde_json::to_string(&[&marker.issuer, &marker.pass_id])?;
    let pseudonym = pseudonymize_record(
        key,
        GovernanceContext::RelyingService,
        GovernedRecordClass::PassConsumption,
        &record_key,
    );
    let delete_after = pass_retention_floors(marker.retention(), policy)?.final_deletion;
    insert_tombstone(
        transaction,
        NewTombstone {
            record_class: GovernedRecordClass::PassConsumption,
            pseudonym: &pseudonym,
            terminal_status: "consumed",
            maybe_protected_action_type: None,
            maybe_action_policy: None,
            terminal_at: marker.consumed_at,
            pseudonymized_at,
            delete_after,
        },
    )
    .await
}

async fn insert_tombstone(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    tombstone: NewTombstone<'_>,
) -> Result<(), GovernanceError> {
    sqlx::query(include_str!("../queries/insert_relying_tombstone.sql"))
        .bind(Uuid::new_v4())
        .bind(tombstone.record_class.as_str())
        .bind(tombstone.pseudonym)
        .bind(tombstone.terminal_status)
        .bind(tombstone.maybe_protected_action_type)
        .bind(tombstone.maybe_action_policy)
        .bind(to_i64(tombstone.terminal_at)?)
        .bind(to_i64(tombstone.pseudonymized_at)?)
        .bind(to_i64(tombstone.delete_after)?)
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

async fn delete_relying_aggregate(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    redemption_id: &str,
) -> Result<u64, GovernanceError> {
    let deleted = sqlx::query(include_str!("../queries/delete_relying_aggregate.sql"))
        .bind(redemption_id)
        .execute(&mut **transaction)
        .await?;
    Ok(deleted.rows_affected())
}

fn parse_pass_marker_key(value: &str) -> Result<(String, String), GovernanceError> {
    let values = serde_json::from_str::<Vec<String>>(value)?;
    let [issuer, pass_id] =
        <[String; 2]>::try_from(values).map_err(|_| GovernanceError::InvalidPersistedData)?;
    Ok((issuer, pass_id))
}

fn parse_terminal_status(value: &str) -> Result<RelyingTerminalStatus, GovernanceError> {
    match value {
        "succeeded" => Ok(RelyingTerminalStatus::Succeeded),
        "failed" => Ok(RelyingTerminalStatus::Failed),
        _ => Err(GovernanceError::InvalidPersistedData),
    }
}

impl PassMarker {
    const fn retention(&self) -> PassRetentionMarker {
        PassRetentionMarker {
            consumed_at: self.consumed_at,
            expires_at: self.expires_at,
        }
    }
}
