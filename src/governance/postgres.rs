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

static AUTHORITY_MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations/gate_authority");
static REFERENCE_MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations/relying_service");

pub(super) struct PostgresGovernanceRepository {
    pool: PgPool,
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
        let bootstrap_pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(database_url)
            .await?;
        let create_schema = match context {
            GovernanceContext::GateAuthority => "CREATE SCHEMA IF NOT EXISTS gate_authority",
            GovernanceContext::RelyingService => "CREATE SCHEMA IF NOT EXISTS relying_service",
        };
        sqlx::query(create_schema).execute(&bootstrap_pool).await?;
        bootstrap_pool.close().await;

        let search_path = format!("{},public", context.as_str());
        let options = sqlx::postgres::PgConnectOptions::from_str(database_url)?
            .options([("search_path", search_path.as_str())]);
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await?;
        match context {
            GovernanceContext::GateAuthority => AUTHORITY_MIGRATOR.run(&pool).await?,
            GovernanceContext::RelyingService => REFERENCE_MIGRATOR.run(&pool).await?,
        }
        Ok(Self { pool })
    }

    pub(super) async fn plan_retention(
        &self,
        context: GovernanceContext,
        as_of_unix_seconds: u64,
        policy: RetentionPolicy,
    ) -> Result<GovernanceManifest, GovernanceError> {
        let candidates = self.replay_candidates(context, as_of_unix_seconds).await?;
        let mut items = Vec::with_capacity(candidates.len());
        let mut count_by_transition = BTreeMap::new();
        for (record_class, record_key, retention_floor_unix_seconds) in candidates {
            let candidate = RetentionCandidate::new(
                record_class,
                RetentionState::Identifying,
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
        let planned_counts = count_by_transition
            .into_iter()
            .map(|((record_class, action, reason), count)| PlannedCount {
                record_class,
                action,
                reason,
                count,
            })
            .collect::<Vec<_>>();
        let material = DigestMaterial {
            schema_version: "bwg-governance-plan-v1",
            context,
            as_of_unix_seconds,
            policy,
            planned_counts: &planned_counts,
            items: &items,
        };
        let manifest_digest = sha256_hex(&serde_json::to_vec(&material)?);
        let job_id = Uuid::new_v4();
        let eligible_items =
            u64::try_from(items.len()).map_err(|_| GovernanceError::InvalidPersistedData)?;
        let mut transaction = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO governance_retention_jobs
             (job_id, manifest_digest, as_of_unix_seconds, policy, status, cursor,
              eligible_items, created_at_unix_seconds)
             VALUES ($1, $2, $3, $4, 'planned', 0, $5, $3)",
        )
        .bind(job_id)
        .bind(&manifest_digest)
        .bind(to_i64(as_of_unix_seconds)?)
        .bind(serde_json::to_value(policy)?)
        .bind(to_i64(eligible_items)?)
        .execute(&mut *transaction)
        .await?;
        for item in items {
            sqlx::query(
                "INSERT INTO governance_retention_items
                 (job_id, sequence, record_class, record_key, action, eligibility_reason,
                  retention_floor_unix_seconds)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)",
            )
            .bind(job_id)
            .bind(to_i64(item.sequence)?)
            .bind(record_class_name(item.record_class))
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
            context,
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
        context: GovernanceContext,
        request: ApplyRetentionRequest,
    ) -> Result<ApplyRetentionResult, GovernanceError> {
        let mut transaction = self.pool.begin().await?;
        let maybe_job = sqlx::query(
            "SELECT manifest_digest, status, cursor, eligible_items, as_of_unix_seconds
             FROM governance_retention_jobs
             WHERE job_id = $1
             FOR UPDATE",
        )
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
        let status = parse_job_status(&job.try_get::<String, _>("status")?)?;
        let cursor = to_u64(job.try_get("cursor")?)?;
        let eligible_items = to_u64(job.try_get("eligible_items")?)?;
        let as_of = job.try_get::<i64, _>("as_of_unix_seconds")?;
        if status == RetentionJobStatus::Completed {
            transaction.commit().await?;
            return Ok(ApplyRetentionResult {
                job_id: request.job_id.to_string(),
                context,
                manifest_digest,
                status,
                cursor,
                deleted_items: 0,
                pseudonymized_items: 0,
            });
        }

        let items = sqlx::query(
            "SELECT sequence, record_class, record_key, action
             FROM governance_retention_items
             WHERE job_id = $1 AND sequence > $2
             ORDER BY sequence
             LIMIT $3",
        )
        .bind(request.job_id)
        .bind(to_i64(cursor)?)
        .bind(to_i64(request.batch_size)?)
        .fetch_all(&mut *transaction)
        .await?;
        let mut next_cursor = cursor;
        let mut deleted_items = 0_u64;
        let pseudonymized_items = 0_u64;
        for item in items {
            let sequence = to_u64(item.try_get("sequence")?)?;
            let record_class = item.try_get::<String, _>("record_class")?;
            let record_key = item.try_get::<String, _>("record_key")?;
            let action = item.try_get::<String, _>("action")?;
            if action != RetentionAction::Delete.as_str() {
                return Err(GovernanceError::InvalidPersistedData);
            }
            let affected =
                delete_replay_material(&mut transaction, context, &record_class, &record_key)
                    .await?;
            if affected != 1 {
                return Err(GovernanceError::StaleRetentionPlan);
            }
            next_cursor = sequence;
            deleted_items += 1;
        }
        let completed = next_cursor >= eligible_items;
        let next_status = if completed {
            RetentionJobStatus::Completed
        } else {
            RetentionJobStatus::Applying
        };
        sqlx::query(
            "UPDATE governance_retention_jobs
             SET status = $2, cursor = $3,
                 completed_at_unix_seconds = CASE WHEN $2 = 'completed' THEN $4 ELSE NULL END
             WHERE job_id = $1",
        )
        .bind(request.job_id)
        .bind(next_status.as_str())
        .bind(to_i64(next_cursor)?)
        .bind(as_of)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(ApplyRetentionResult {
            job_id: request.job_id.to_string(),
            context,
            manifest_digest,
            status: next_status,
            cursor: next_cursor,
            deleted_items,
            pseudonymized_items,
        })
    }

    async fn replay_candidates(
        &self,
        context: GovernanceContext,
        as_of_unix_seconds: u64,
    ) -> Result<Vec<(GovernedRecordClass, String, u64)>, GovernanceError> {
        let as_of = to_i64(as_of_unix_seconds)?;
        match context {
            GovernanceContext::GateAuthority => {
                let rows = sqlx::query(
                    "SELECT proof_id, expires_at_unix_seconds
                     FROM claimant_issuance_proofs
                     WHERE expires_at_unix_seconds < $1
                     ORDER BY proof_id",
                )
                .bind(as_of)
                .fetch_all(&self.pool)
                .await?;
                rows.into_iter()
                    .map(|row| {
                        Ok((
                            GovernedRecordClass::ClaimantIssuanceProofReplay,
                            row.try_get("proof_id")?,
                            to_u64(row.try_get("expires_at_unix_seconds")?)?,
                        ))
                    })
                    .collect()
            }
            GovernanceContext::RelyingService => {
                let rows = sqlx::query(
                    "SELECT proof_id, expires_at_unix_seconds, record_class
                     FROM (
                         SELECT proof_id, expires_at_unix_seconds,
                                'dpop_proof_replay' AS record_class
                         FROM dpop_proofs
                         WHERE expires_at_unix_seconds < $1
                         UNION ALL
                         SELECT proof_id, expires_at_unix_seconds,
                                'claimant_outcome_proof_replay' AS record_class
                         FROM claimant_outcome_proofs
                         WHERE expires_at_unix_seconds < $1
                     ) AS replay_material
                     ORDER BY record_class, proof_id",
                )
                .bind(as_of)
                .fetch_all(&self.pool)
                .await?;
                rows.into_iter()
                    .map(|row| {
                        let record_class = match row.try_get::<String, _>("record_class")?.as_str()
                        {
                            "dpop_proof_replay" => GovernedRecordClass::DpopProofReplay,
                            "claimant_outcome_proof_replay" => {
                                GovernedRecordClass::ClaimantOutcomeProofReplay
                            }
                            _ => return Err(GovernanceError::InvalidPersistedData),
                        };
                        Ok((
                            record_class,
                            row.try_get("proof_id")?,
                            to_u64(row.try_get("expires_at_unix_seconds")?)?,
                        ))
                    })
                    .collect()
            }
        }
    }
}

async fn delete_replay_material(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    context: GovernanceContext,
    record_class: &str,
    record_key: &str,
) -> Result<u64, GovernanceError> {
    let result = match (context, record_class) {
        (GovernanceContext::GateAuthority, "claimant_issuance_proof_replay") => {
            sqlx::query("DELETE FROM claimant_issuance_proofs WHERE proof_id = $1")
                .bind(record_key)
                .execute(&mut **transaction)
                .await?
        }
        (GovernanceContext::RelyingService, "dpop_proof_replay") => {
            sqlx::query("DELETE FROM dpop_proofs WHERE proof_id = $1")
                .bind(record_key)
                .execute(&mut **transaction)
                .await?
        }
        (GovernanceContext::RelyingService, "claimant_outcome_proof_replay") => {
            sqlx::query("DELETE FROM claimant_outcome_proofs WHERE proof_id = $1")
                .bind(record_key)
                .execute(&mut **transaction)
                .await?
        }
        _ => return Err(GovernanceError::InvalidPersistedData),
    };
    Ok(result.rows_affected())
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

const fn record_class_name(record_class: GovernedRecordClass) -> &'static str {
    match record_class {
        GovernedRecordClass::ClaimantIssuanceProofReplay => "claimant_issuance_proof_replay",
        GovernedRecordClass::SignedGatePass => "signed_gate_pass",
        GovernedRecordClass::AuthorityOperational => "authority_operational",
        GovernedRecordClass::DpopProofReplay => "dpop_proof_replay",
        GovernedRecordClass::ClaimantOutcomeProofReplay => "claimant_outcome_proof_replay",
        GovernedRecordClass::PassConsumption => "pass_consumption",
        GovernedRecordClass::RelyingServiceOperational => "relying_service_operational",
        GovernedRecordClass::GovernanceAudit => "governance_audit",
    }
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
        EligibilityReason::TombstoneWindowElapsed => "tombstone_window_elapsed",
    }
}
