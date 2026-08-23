use std::{collections::BTreeMap, str::FromStr as _};

use ring::digest::{SHA256, digest};
use serde::Serialize;
use sqlx::{PgPool, Row as _, postgres::PgPoolOptions};
use uuid::Uuid;

use super::{
    ApplyRetentionRequest, ApplyRetentionResult, EligibilityReason, GovernanceContext,
    GovernanceError, GovernanceManifest, GovernedRecordClass, PlannedCount, RetentionAction,
    RetentionCandidate, RetentionJobStatus, RetentionPolicy, RetentionState, plan_candidate,
};

mod authority_retention;
mod reference_retention;
mod retention_apply;

static AUTHORITY_MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations/gate_authority");
static REFERENCE_MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations/relying_service");

pub(super) struct PostgresGovernanceRepository {
    pool: PgPool,
    profile: ContextProfile,
}

#[derive(Clone, Copy)]
struct ContextProfile {
    context: GovernanceContext,
    create_schema: &'static str,
    migrator: &'static sqlx::migrate::Migrator,
    retention_candidates_query: &'static str,
}

impl ContextProfile {
    const fn for_context(context: GovernanceContext) -> Self {
        match context {
            GovernanceContext::GateAuthority => Self {
                context,
                create_schema: "CREATE SCHEMA IF NOT EXISTS gate_authority",
                migrator: &AUTHORITY_MIGRATOR,
                retention_candidates_query: include_str!(
                    "queries/authority_retention_candidates.sql"
                ),
            },
            GovernanceContext::RelyingService => Self {
                context,
                create_schema: "CREATE SCHEMA IF NOT EXISTS relying_service",
                migrator: &REFERENCE_MIGRATOR,
                retention_candidates_query: include_str!(
                    "queries/reference_retention_candidates.sql"
                ),
            },
        }
    }
}

#[derive(Debug, Serialize)]
struct PlannedItem {
    sequence: u64,
    record_class: GovernedRecordClass,
    record_key_digest: String,
    #[serde(skip)]
    record_key: String,
    action: RetentionAction,
    reason: EligibilityReason,
    retention_floor_unix_seconds: u64,
}

#[derive(Serialize)]
struct DigestMaterial<'a> {
    schema_version: &'static str,
    context: GovernanceContext,
    as_of_unix_seconds: u64,
    policy: RetentionPolicy,
    planned_counts: &'a [PlannedCount],
    items: &'a [PlannedItem],
}

impl PostgresGovernanceRepository {
    pub(super) async fn connect(
        context: GovernanceContext,
        database_url: &str,
    ) -> Result<Self, GovernanceError> {
        let profile = ContextProfile::for_context(context);
        let bootstrap_pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(database_url)
            .await?;
        sqlx::query(profile.create_schema)
            .execute(&bootstrap_pool)
            .await?;
        bootstrap_pool.close().await;

        let search_path = format!("{},public", context.as_str());
        let options = sqlx::postgres::PgConnectOptions::from_str(database_url)?
            .options([("search_path", search_path.as_str())]);
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await?;
        profile.migrator.run(&pool).await?;
        Ok(Self { pool, profile })
    }

    pub(super) async fn plan_retention(
        &self,
        as_of_unix_seconds: u64,
        policy: RetentionPolicy,
    ) -> Result<GovernanceManifest, GovernanceError> {
        let candidates = self
            .retention_candidates(as_of_unix_seconds, policy)
            .await?;
        let mut items = Vec::with_capacity(candidates.len());
        let mut count_by_transition = BTreeMap::new();
        for (record_class, retention_state, record_key, retention_floor_unix_seconds) in candidates
        {
            let candidate = RetentionCandidate::new(
                record_class,
                retention_state,
                retention_floor_unix_seconds,
            );
            let Some(planned) = plan_candidate(&candidate, as_of_unix_seconds, policy)? else {
                continue;
            };
            let sequence = u64::try_from(items.len() + 1)
                .map_err(|_| GovernanceError::InvalidPersistedData)?;
            *count_by_transition
                .entry((record_class, planned.action(), planned.reason()))
                .or_insert(0) += 1;
            items.push(PlannedItem {
                sequence,
                record_class,
                record_key_digest: sha256_hex(record_key.as_bytes()),
                record_key,
                action: planned.action(),
                reason: planned.reason(),
                retention_floor_unix_seconds,
            });
        }
        let planned_counts = planned_counts(count_by_transition);
        let manifest_digest =
            manifest_digest_for(self.profile.context, as_of_unix_seconds, policy, &items)?;
        let job_id = Uuid::new_v4();
        let eligible_items =
            u64::try_from(items.len()).map_err(|_| GovernanceError::InvalidPersistedData)?;
        let mut transaction = self.pool.begin().await?;
        sqlx::query(include_str!("queries/insert_retention_job.sql"))
            .bind(job_id)
            .bind(&manifest_digest)
            .bind(to_i64(as_of_unix_seconds)?)
            .bind(serde_json::to_value(policy)?)
            .bind(to_i64(eligible_items)?)
            .execute(&mut *transaction)
            .await?;
        for item in items {
            sqlx::query(include_str!("queries/insert_retention_item.sql"))
                .bind(job_id)
                .bind(to_i64(item.sequence)?)
                .bind(item.record_class.as_str())
                .bind(item.record_key)
                .bind(item.action.as_str())
                .bind(eligibility_reason_name(item.reason))
                .bind(to_i64(item.retention_floor_unix_seconds)?)
                .execute(&mut *transaction)
                .await?;
        }
        transaction.commit().await?;
        Ok(GovernanceManifest {
            job_id: job_id.to_string(),
            context: self.profile.context,
            as_of_unix_seconds,
            policy,
            status: RetentionJobStatus::Planned,
            eligible_items,
            planned_counts,
            manifest_digest,
        })
    }

    pub(super) async fn apply_retention(
        &self,
        request: ApplyRetentionRequest,
    ) -> Result<ApplyRetentionResult, GovernanceError> {
        let mut transaction = self.pool.begin().await?;
        let maybe_job = sqlx::query(include_str!("queries/select_retention_job_for_apply.sql"))
            .bind(request.job_id)
            .fetch_optional(&mut *transaction)
            .await?;
        let Some(job) = maybe_job else {
            return Err(GovernanceError::UnknownRetentionJob);
        };
        let manifest_digest = job.try_get::<String, _>("manifest_digest")?;
        if manifest_digest != request.manifest_digest {
            return Err(GovernanceError::ManifestDigestMismatch);
        }
        let policy = serde_json::from_value::<RetentionPolicy>(job.try_get("policy")?)?;
        if policy != request.policy {
            return Err(GovernanceError::StaleRetentionPolicy);
        }
        let status = parse_job_status(&job.try_get::<String, _>("status")?)?;
        let cursor = to_u64(job.try_get("cursor")?)?;
        let eligible_items = to_u64(job.try_get("eligible_items")?)?;
        let as_of_unix_seconds = to_u64(job.try_get("as_of_unix_seconds")?)?;
        let persisted_items = sqlx::query(include_str!("queries/select_retention_items.sql"))
            .bind(request.job_id)
            .fetch_all(&mut *transaction)
            .await?
            .into_iter()
            .map(planned_item_from_row)
            .collect::<Result<Vec<_>, _>>()?;
        if u64::try_from(persisted_items.len())
            .map_err(|_| GovernanceError::InvalidPersistedData)?
            != eligible_items
        {
            return Err(GovernanceError::ManifestDigestMismatch);
        }
        let recomputed_digest = manifest_digest_for(
            self.profile.context,
            as_of_unix_seconds,
            policy,
            &persisted_items,
        )?;
        if recomputed_digest != manifest_digest {
            return Err(GovernanceError::ManifestDigestMismatch);
        }
        if status == RetentionJobStatus::Completed {
            transaction.commit().await?;
            return Ok(ApplyRetentionResult {
                job_id: request.job_id.to_string(),
                context: self.profile.context,
                manifest_digest,
                status,
                cursor,
                deleted_items: 0,
                pseudonymized_items: 0,
            });
        }

        let mut next_cursor = cursor;
        let mut deleted_items = 0_u64;
        let mut pseudonymized_items = 0_u64;
        let batch_size = usize::try_from(request.batch_size)
            .map_err(|_| GovernanceError::InvalidPersistedData)?;
        for item in persisted_items
            .iter()
            .filter(|item| item.sequence > cursor)
            .take(batch_size)
        {
            let applied = retention_apply::apply_transition(
                &mut transaction,
                self.profile.context,
                item,
                as_of_unix_seconds,
                policy,
                request.maybe_pseudonymization_key.as_ref(),
            )
            .await?;
            if applied.affected() != 1 {
                return Err(GovernanceError::StaleRetentionPlan);
            }
            next_cursor = item.sequence;
            match applied {
                retention_apply::AppliedTransition::Deleted(_) => deleted_items += 1,
                retention_apply::AppliedTransition::Pseudonymized(_) => {
                    pseudonymized_items += 1;
                }
            }
        }
        let completed = next_cursor >= eligible_items;
        let next_status = if completed {
            RetentionJobStatus::Completed
        } else {
            RetentionJobStatus::Applying
        };
        sqlx::query(include_str!("queries/update_retention_job.sql"))
            .bind(request.job_id)
            .bind(next_status.as_str())
            .bind(to_i64(next_cursor)?)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(ApplyRetentionResult {
            job_id: request.job_id.to_string(),
            context: self.profile.context,
            manifest_digest,
            status: next_status,
            cursor: next_cursor,
            deleted_items,
            pseudonymized_items,
        })
    }

    async fn retention_candidates(
        &self,
        as_of_unix_seconds: u64,
        policy: RetentionPolicy,
    ) -> Result<Vec<(GovernedRecordClass, RetentionState, String, u64)>, GovernanceError> {
        let rows = sqlx::query(self.profile.retention_candidates_query)
            .bind(to_i64(as_of_unix_seconds)?)
            .bind(to_i64(policy.operational_retention_seconds())?)
            .bind(to_i64(policy.tombstone_retention_seconds())?)
            .fetch_all(&self.pool)
            .await?;
        rows.into_iter()
            .map(|row| {
                let record_class = parse_record_class(&row.try_get::<String, _>("record_class")?)?;
                if !record_class_allowed_in_context(record_class, self.profile.context) {
                    return Err(GovernanceError::InvalidPersistedData);
                }
                let retention_state =
                    parse_retention_state(&row.try_get::<String, _>("retention_state")?)?;
                Ok((
                    record_class,
                    retention_state,
                    row.try_get("record_key")?,
                    to_u64(row.try_get("retention_floor_unix_seconds")?)?,
                ))
            })
            .collect()
    }
}

async fn delete_protocol_material(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    context: GovernanceContext,
    item: &PlannedItem,
    as_of_unix_seconds: u64,
) -> Result<u64, GovernanceError> {
    if !record_class_allowed_in_context(item.record_class, context) {
        return Err(GovernanceError::InvalidPersistedData);
    }
    let result = match item.record_class {
        GovernedRecordClass::SignedGatePass => {
            sqlx::query(include_str!("queries/clear_signed_gate_pass.sql"))
                .bind(&item.record_key)
                .bind(to_i64(item.retention_floor_unix_seconds)?)
                .bind(to_i64(as_of_unix_seconds)?)
                .execute(&mut **transaction)
                .await?
        }
        record_class => {
            let query = replay_delete_query(record_class)?;
            let expected_expiry = item
                .retention_floor_unix_seconds
                .checked_sub(1)
                .ok_or(GovernanceError::InvalidPersistedData)?;
            sqlx::query(query)
                .bind(&item.record_key)
                .bind(to_i64(expected_expiry)?)
                .bind(to_i64(as_of_unix_seconds)?)
                .execute(&mut **transaction)
                .await?
        }
    };
    Ok(result.rows_affected())
}

fn planned_item_from_row(row: sqlx::postgres::PgRow) -> Result<PlannedItem, GovernanceError> {
    let record_class = parse_record_class(&row.try_get::<String, _>("record_class")?)?;
    let record_key = row.try_get::<String, _>("record_key")?;
    Ok(PlannedItem {
        sequence: to_u64(row.try_get("sequence")?)?,
        record_class,
        record_key_digest: sha256_hex(record_key.as_bytes()),
        record_key,
        action: parse_retention_action(&row.try_get::<String, _>("action")?)?,
        reason: parse_eligibility_reason(&row.try_get::<String, _>("eligibility_reason")?)?,
        retention_floor_unix_seconds: to_u64(row.try_get("retention_floor_unix_seconds")?)?,
    })
}

fn manifest_digest_for(
    context: GovernanceContext,
    as_of_unix_seconds: u64,
    policy: RetentionPolicy,
    items: &[PlannedItem],
) -> Result<String, GovernanceError> {
    let planned_counts = planned_counts(items.iter().fold(BTreeMap::new(), |mut counts, item| {
        *counts
            .entry((item.record_class, item.action, item.reason))
            .or_insert(0) += 1;
        counts
    }));
    let material = DigestMaterial {
        schema_version: "bwg-governance-plan-v1",
        context,
        as_of_unix_seconds,
        policy,
        planned_counts: &planned_counts,
        items,
    };
    Ok(sha256_hex(&serde_json::to_vec(&material)?))
}

fn planned_counts(
    counts: BTreeMap<(GovernedRecordClass, RetentionAction, EligibilityReason), u64>,
) -> Vec<PlannedCount> {
    counts
        .into_iter()
        .map(|((record_class, action, reason), count)| PlannedCount {
            record_class,
            action,
            reason,
            count,
        })
        .collect()
}

fn parse_record_class(value: &str) -> Result<GovernedRecordClass, GovernanceError> {
    match value {
        "claimant_issuance_proof_replay" => Ok(GovernedRecordClass::ClaimantIssuanceProofReplay),
        "signed_gate_pass" => Ok(GovernedRecordClass::SignedGatePass),
        "authority_operational" => Ok(GovernedRecordClass::AuthorityOperational),
        "dpop_proof_replay" => Ok(GovernedRecordClass::DpopProofReplay),
        "claimant_outcome_proof_replay" => Ok(GovernedRecordClass::ClaimantOutcomeProofReplay),
        "pass_consumption" => Ok(GovernedRecordClass::PassConsumption),
        "relying_service_operational" => Ok(GovernedRecordClass::RelyingServiceOperational),
        "governance_audit" => Ok(GovernedRecordClass::GovernanceAudit),
        _ => Err(GovernanceError::InvalidPersistedData),
    }
}

fn parse_retention_action(value: &str) -> Result<RetentionAction, GovernanceError> {
    match value {
        "pseudonymize" => Ok(RetentionAction::Pseudonymize),
        "delete" => Ok(RetentionAction::Delete),
        _ => Err(GovernanceError::InvalidPersistedData),
    }
}

fn parse_retention_state(value: &str) -> Result<RetentionState, GovernanceError> {
    match value {
        "identifying" => Ok(RetentionState::Identifying),
        "pseudonymized" => Ok(RetentionState::Pseudonymized),
        "overdue_identifying" => Ok(RetentionState::OverdueIdentifying),
        _ => Err(GovernanceError::InvalidPersistedData),
    }
}

fn parse_eligibility_reason(value: &str) -> Result<EligibilityReason, GovernanceError> {
    match value {
        "protocol_retention_floor_reached" => Ok(EligibilityReason::ProtocolRetentionFloorReached),
        "operational_window_elapsed" => Ok(EligibilityReason::OperationalWindowElapsed),
        "overdue_retention_window_elapsed" => Ok(EligibilityReason::OverdueRetentionWindowElapsed),
        "tombstone_window_elapsed" => Ok(EligibilityReason::TombstoneWindowElapsed),
        _ => Err(GovernanceError::InvalidPersistedData),
    }
}

const fn record_class_allowed_in_context(
    record_class: GovernedRecordClass,
    context: GovernanceContext,
) -> bool {
    matches!(
        (record_class, context),
        (
            GovernedRecordClass::ClaimantIssuanceProofReplay
                | GovernedRecordClass::SignedGatePass
                | GovernedRecordClass::AuthorityOperational,
            GovernanceContext::GateAuthority
        ) | (
            GovernedRecordClass::DpopProofReplay
                | GovernedRecordClass::ClaimantOutcomeProofReplay
                | GovernedRecordClass::PassConsumption
                | GovernedRecordClass::RelyingServiceOperational,
            GovernanceContext::RelyingService
        ) | (GovernedRecordClass::GovernanceAudit, _)
    )
}

const fn replay_delete_query(
    record_class: GovernedRecordClass,
) -> Result<&'static str, GovernanceError> {
    match record_class {
        GovernedRecordClass::ClaimantIssuanceProofReplay => {
            Ok(include_str!("queries/delete_issuance_proof.sql"))
        }
        GovernedRecordClass::DpopProofReplay => Ok(include_str!("queries/delete_dpop_proof.sql")),
        GovernedRecordClass::ClaimantOutcomeProofReplay => {
            Ok(include_str!("queries/delete_outcome_proof.sql"))
        }
        _ => Err(GovernanceError::InvalidPersistedData),
    }
}

fn to_i64(value: u64) -> Result<i64, GovernanceError> {
    i64::try_from(value).map_err(|_| GovernanceError::InvalidPersistedData)
}

fn to_u64(value: i64) -> Result<u64, GovernanceError> {
    u64::try_from(value).map_err(|_| GovernanceError::InvalidPersistedData)
}

fn sha256_hex(bytes: &[u8]) -> String {
    digest(&SHA256, bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn parse_job_status(value: &str) -> Result<RetentionJobStatus, GovernanceError> {
    match value {
        "planned" => Ok(RetentionJobStatus::Planned),
        "applying" => Ok(RetentionJobStatus::Applying),
        "completed" => Ok(RetentionJobStatus::Completed),
        "failed" => Ok(RetentionJobStatus::Failed),
        _ => Err(GovernanceError::InvalidPersistedData),
    }
}

const fn eligibility_reason_name(reason: EligibilityReason) -> &'static str {
    match reason {
        EligibilityReason::ProtocolRetentionFloorReached => "protocol_retention_floor_reached",
        EligibilityReason::OperationalWindowElapsed => "operational_window_elapsed",
        EligibilityReason::OverdueRetentionWindowElapsed => "overdue_retention_window_elapsed",
        EligibilityReason::TombstoneWindowElapsed => "tombstone_window_elapsed",
    }
}
