use std::str::FromStr as _;

use async_trait::async_trait;
use sqlx::{
    Row as _,
    postgres::{PgConnectOptions, PgPoolOptions},
};
use uuid::Uuid;

use super::{
    ClaimedAction, NewProtectedAction, OutcomeBinding, ReferencePersistenceError,
    ReferenceRepository, ValidatedRedemption,
};
use crate::redemption::{ProtectedActionOutcome, ProtectedActionResult, RedemptionRecord};

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations/relying_service");

pub(crate) struct PostgresReferenceRepository {
    pool: sqlx::PgPool,
}

impl PostgresReferenceRepository {
    pub(crate) async fn connect(database_url: &str) -> Result<Self, ReferencePersistenceError> {
        let bootstrap_pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(database_url)
            .await?;
        sqlx::query("CREATE SCHEMA IF NOT EXISTS relying_service")
            .execute(&bootstrap_pool)
            .await?;
        bootstrap_pool.close().await;
        let connect_options = PgConnectOptions::from_str(database_url)?
            .options([("search_path", "relying_service,public")]);
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect_with(connect_options)
            .await?;
        MIGRATOR.run(&pool).await?;
        Ok(Self { pool })
    }
}

#[async_trait]
impl ReferenceRepository for PostgresReferenceRepository {
    async fn replace_trusted_authority_keys(
        &self,
        issuer: &str,
        keys: &[crate::crypto_profile::AuthorityJwkWire],
    ) -> Result<(), ReferencePersistenceError> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query("DELETE FROM relying_service.trusted_authority_keys WHERE issuer = $1")
            .bind(issuer)
            .execute(&mut *transaction)
            .await?;
        for key in keys {
            let key_json = serde_json::to_value(key)
                .map_err(|_| ReferencePersistenceError::InvalidPersistedData)?;
            sqlx::query(include_str!("postgres/queries/insert_trusted_key.sql"))
                .bind(issuer)
                .bind(key.kid())
                .bind(key_json)
                .execute(&mut *transaction)
                .await?;
        }
        transaction.commit().await?;
        Ok(())
    }

    async fn trusted_authority_keys(
        &self,
        issuer: &str,
    ) -> Result<Vec<crate::crypto_profile::AuthorityJwkWire>, ReferencePersistenceError> {
        let rows = sqlx::query_scalar::<_, serde_json::Value>(include_str!(
            "postgres/queries/select_trusted_keys.sql"
        ))
        .bind(issuer)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                serde_json::from_value(row)
                    .map_err(|_| ReferencePersistenceError::InvalidPersistedData)
            })
            .collect()
    }

    async fn insert_protected_action(
        &self,
        action: NewProtectedAction<'_>,
    ) -> Result<(), ReferencePersistenceError> {
        let retryable_error_classes = serde_json::to_value(action.retryable_error_classes)
            .map_err(|_| ReferencePersistenceError::InvalidPersistedData)?;
        let result = sqlx::query(include_str!("postgres/queries/insert_protected_action.sql"))
            .bind(action.audience)
            .bind(action.action_reference)
            .bind(action.claimant_jkt)
            .bind(action.protected_action_type)
            .bind(action.action_policy)
            .bind(to_i64(action.execution_timeout_seconds)?)
            .bind(
                i32::try_from(action.maximum_attempts)
                    .map_err(|_| ReferencePersistenceError::InvalidPersistedData)?,
            )
            .bind(retryable_error_classes)
            .bind(to_i64(action.created_at_unix_seconds)?)
            .execute(&self.pool)
            .await;
        match result {
            Ok(_) => Ok(()),
            Err(error)
                if error
                    .as_database_error()
                    .is_some_and(|error| error.is_unique_violation()) =>
            {
                Err(ReferencePersistenceError::DuplicateProtectedAction)
            }
            Err(error) => Err(error.into()),
        }
    }

    async fn redeem(
        &self,
        redemption: ValidatedRedemption<'_>,
    ) -> Result<RedemptionRecord, ReferencePersistenceError> {
        let mut transaction = self.pool.begin().await?;
        let maybe_action = sqlx::query(include_str!(
            "postgres/queries/lock_action_for_redemption.sql"
        ))
        .bind(redemption.audience)
        .bind(redemption.action_reference)
        .fetch_optional(&mut *transaction)
        .await?;
        let Some(action) = maybe_action else {
            return Err(ReferencePersistenceError::UnknownProtectedAction);
        };
        let claimant_jkt = action.try_get::<String, _>("claimant_jkt")?;
        let protected_action_type = action.try_get::<String, _>("protected_action_type")?;
        let action_policy = action.try_get::<String, _>("action_policy")?;
        if claimant_jkt != redemption.claimant_jkt
            || protected_action_type != redemption.protected_action_type
            || action_policy != redemption.action_policy
        {
            return Err(ReferencePersistenceError::ActionBindingConflict);
        }

        sqlx::query("DELETE FROM relying_service.dpop_proofs WHERE expires_at_unix_seconds < $1")
            .bind(to_i64(redemption.accepted_at_unix_seconds)?)
            .execute(&mut *transaction)
            .await?;
        let proof_result = sqlx::query(include_str!("postgres/queries/insert_dpop_proof.sql"))
            .bind(redemption.dpop_proof_id)
            .bind(to_i64(redemption.dpop_expires_at_unix_seconds)?)
            .execute(&mut *transaction)
            .await;
        if proof_result
            .as_ref()
            .err()
            .and_then(sqlx::Error::as_database_error)
            .is_some_and(|error| error.is_unique_violation())
        {
            return Err(ReferencePersistenceError::ReplayedDpopProof);
        }
        proof_result?;

        let maybe_consumed = sqlx::query_scalar::<_, String>(include_str!(
            "postgres/queries/select_pass_consumption.sql"
        ))
        .bind(redemption.issuer)
        .bind(redemption.pass_id)
        .fetch_optional(&mut *transaction)
        .await?;
        if maybe_consumed.is_some() {
            return Err(ReferencePersistenceError::ConsumedPass);
        }

        let maybe_redemption_id = sqlx::query_scalar::<_, String>(include_str!(
            "postgres/queries/select_redemption_for_action.sql"
        ))
        .bind(redemption.audience)
        .bind(redemption.action_reference)
        .fetch_optional(&mut *transaction)
        .await?;
        let redemption_id = match maybe_redemption_id {
            Some(redemption_id) => redemption_id,
            None => insert_redemption(&mut transaction, &redemption, &action).await?,
        };
        sqlx::query(include_str!("postgres/queries/insert_pass_consumption.sql"))
            .bind(redemption.issuer)
            .bind(redemption.pass_id)
            .bind(&redemption_id)
            .bind(to_i64(redemption.accepted_at_unix_seconds)?)
            .execute(&mut *transaction)
            .await?;
        let record = select_redemption(&mut transaction, &redemption_id).await?;
        transaction.commit().await?;
        Ok(record)
    }

    async fn maybe_claim_action(
        &self,
        worker_id: &str,
        now: u64,
        lease_expires_at: u64,
    ) -> Result<Option<ClaimedAction>, ReferencePersistenceError> {
        let now = to_i64(now)?;
        let mut transaction = self.pool.begin().await?;
        sqlx::query("DELETE FROM relying_service.dpop_proofs WHERE expires_at_unix_seconds < $1")
            .bind(now)
            .execute(&mut *transaction)
            .await?;
        sqlx::query(
            "DELETE FROM relying_service.claimant_outcome_proofs WHERE expires_at_unix_seconds < $1",
        )
        .bind(now)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(include_str!(
            "postgres/queries/abandon_expired_attempts.sql"
        ))
        .bind(now)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(include_str!(
            "postgres/queries/abandon_terminal_attempts.sql"
        ))
        .bind(now)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(include_str!("postgres/queries/fail_exhausted_actions.sql"))
            .bind(now)
            .execute(&mut *transaction)
            .await?;
        let maybe_row = sqlx::query(include_str!("postgres/queries/claim_action.sql"))
            .bind(now)
            .fetch_optional(&mut *transaction)
            .await?;
        let Some(row) = maybe_row else {
            transaction.commit().await?;
            return Ok(None);
        };
        let attempt_number = row
            .try_get::<i32, _>("attempt_count")?
            .checked_add(1)
            .ok_or(ReferencePersistenceError::InvalidPersistedData)?;
        let redemption_id = row.try_get::<String, _>("redemption_id")?;
        sqlx::query(include_str!("postgres/queries/mark_action_processing.sql"))
            .bind(&redemption_id)
            .bind(attempt_number)
            .bind(worker_id)
            .bind(to_i64(lease_expires_at)?)
            .execute(&mut *transaction)
            .await?;
        sqlx::query(include_str!("postgres/queries/insert_action_attempt.sql"))
            .bind(format!("attempt_{}", Uuid::new_v4().simple()))
            .bind(&redemption_id)
            .bind(attempt_number)
            .bind(now)
            .execute(&mut *transaction)
            .await?;
        let action = ClaimedAction {
            redemption_id,
            action_reference: row.try_get("action_reference")?,
            attempt_number: u32::try_from(attempt_number)
                .map_err(|_| ReferencePersistenceError::InvalidPersistedData)?,
            retryable_error_classes: serde_json::from_value(
                row.try_get("retryable_error_classes")?,
            )
            .map_err(|_| ReferencePersistenceError::InvalidPersistedData)?,
        };
        transaction.commit().await?;
        Ok(Some(action))
    }

    async fn complete_account_creation(
        &self,
        worker_id: &str,
        action: &ClaimedAction,
        completed_at: u64,
    ) -> Result<RedemptionRecord, ReferencePersistenceError> {
        let mut transaction = self.pool.begin().await?;
        let completion = sqlx::query(include_str!("postgres/queries/complete_action_intent.sql"))
            .bind(&action.redemption_id)
            .bind(worker_id)
            .execute(&mut *transaction)
            .await?;
        if completion.rows_affected() != 1 {
            return Err(ReferencePersistenceError::LostExecutionLease);
        }
        let proposed_account_id = format!("account_{}", Uuid::new_v4().simple());
        sqlx::query(include_str!(
            "postgres/queries/insert_reference_account.sql"
        ))
        .bind(&proposed_account_id)
        .bind(&action.action_reference)
        .execute(&mut *transaction)
        .await?;
        let account_id = sqlx::query_scalar::<_, String>(include_str!(
            "postgres/queries/select_reference_account.sql"
        ))
        .bind(&action.action_reference)
        .fetch_one(&mut *transaction)
        .await?;
        let safe_result = serde_json::to_value(ProtectedActionResult { account_id })
            .map_err(|_| ReferencePersistenceError::InvalidPersistedData)?;
        let outcome = sqlx::query(include_str!("postgres/queries/complete_action_outcome.sql"))
            .bind(&action.redemption_id)
            .bind(safe_result)
            .execute(&mut *transaction)
            .await?;
        if outcome.rows_affected() != 1 {
            return Err(ReferencePersistenceError::InvalidPersistedData);
        }
        sqlx::query(include_str!("postgres/queries/complete_action_attempt.sql"))
            .bind(&action.redemption_id)
            .bind(
                i32::try_from(action.attempt_number)
                    .map_err(|_| ReferencePersistenceError::InvalidPersistedData)?,
            )
            .bind(to_i64(completed_at)?)
            .execute(&mut *transaction)
            .await?;
        let record = select_redemption(&mut transaction, &action.redemption_id).await?;
        transaction.commit().await?;
        Ok(record)
    }

    async fn fail_claimed_action(
        &self,
        worker_id: &str,
        action: &ClaimedAction,
        safe_reason: &str,
        completed_at: u64,
    ) -> Result<(), ReferencePersistenceError> {
        let mut transaction = self.pool.begin().await?;
        let intent = sqlx::query(include_str!("postgres/queries/fail_claimed_action.sql"))
            .bind(&action.redemption_id)
            .bind(worker_id)
            .execute(&mut *transaction)
            .await?;
        if intent.rows_affected() != 1 {
            return Err(ReferencePersistenceError::LostExecutionLease);
        }
        sqlx::query(include_str!("postgres/queries/fail_action_outcome.sql"))
            .bind(&action.redemption_id)
            .bind(safe_reason)
            .execute(&mut *transaction)
            .await?;
        sqlx::query(include_str!("postgres/queries/abandon_claimed_attempt.sql"))
            .bind(&action.redemption_id)
            .bind(
                i32::try_from(action.attempt_number)
                    .map_err(|_| ReferencePersistenceError::InvalidPersistedData)?,
            )
            .bind(to_i64(completed_at)?)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(())
    }

    async fn schedule_action_retry(
        &self,
        worker_id: &str,
        action: &ClaimedAction,
        retry_at: u64,
    ) -> Result<(), ReferencePersistenceError> {
        let mut transaction = self.pool.begin().await?;
        let intent = sqlx::query(include_str!("postgres/queries/schedule_action_retry.sql"))
            .bind(&action.redemption_id)
            .bind(worker_id)
            .bind(to_i64(retry_at)?)
            .execute(&mut *transaction)
            .await?;
        if intent.rows_affected() != 1 {
            return Err(ReferencePersistenceError::LostExecutionLease);
        }
        sqlx::query(include_str!("postgres/queries/abandon_claimed_attempt.sql"))
            .bind(&action.redemption_id)
            .bind(
                i32::try_from(action.attempt_number)
                    .map_err(|_| ReferencePersistenceError::InvalidPersistedData)?,
            )
            .bind(to_i64(retry_at)?)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(())
    }

    async fn outcome_binding(
        &self,
        audience: &str,
        action_reference: &str,
    ) -> Result<OutcomeBinding, ReferencePersistenceError> {
        let maybe_row = sqlx::query(include_str!("postgres/queries/select_outcome_binding.sql"))
            .bind(audience)
            .bind(action_reference)
            .fetch_optional(&self.pool)
            .await?;
        let Some(row) = maybe_row else {
            return Err(ReferencePersistenceError::UnknownProtectedAction);
        };
        Ok(OutcomeBinding {
            redemption_id: row.try_get("redemption_id")?,
            claimant_jkt: row.try_get("claimant_jkt")?,
            public_lookup_expires_at_unix_seconds: u64::try_from(
                row.try_get::<i64, _>("public_lookup_expires_at_unix_seconds")?,
            )
            .map_err(|_| ReferencePersistenceError::InvalidPersistedData)?,
        })
    }

    async fn consume_outcome_proof(
        &self,
        proof_id: &str,
        expires_at: u64,
        now: u64,
    ) -> Result<(), ReferencePersistenceError> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query(
            "DELETE FROM relying_service.claimant_outcome_proofs WHERE expires_at_unix_seconds < $1",
        )
        .bind(to_i64(now)?)
        .execute(&mut *transaction)
        .await?;
        let result = sqlx::query(include_str!("postgres/queries/insert_outcome_proof.sql"))
            .bind(proof_id)
            .bind(to_i64(expires_at)?)
            .execute(&mut *transaction)
            .await;
        match result {
            Ok(_) => {
                transaction.commit().await?;
                Ok(())
            }
            Err(error)
                if error
                    .as_database_error()
                    .is_some_and(|error| error.is_unique_violation()) =>
            {
                Err(ReferencePersistenceError::ReplayedOutcomeProof)
            }
            Err(error) => Err(error.into()),
        }
    }

    async fn redemption_record(
        &self,
        redemption_id: &str,
    ) -> Result<RedemptionRecord, ReferencePersistenceError> {
        let mut transaction = self.pool.begin().await?;
        let record = select_redemption(&mut transaction, redemption_id).await?;
        transaction.commit().await?;
        Ok(record)
    }
}

async fn insert_redemption(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    redemption: &ValidatedRedemption<'_>,
    action: &sqlx::postgres::PgRow,
) -> Result<String, ReferencePersistenceError> {
    let redemption_id = format!("redemption_{}", Uuid::new_v4().simple());
    let accepted_at = redemption.accepted_at_unix_seconds;
    let execution_timeout = u64::try_from(action.try_get::<i64, _>("execution_timeout_seconds")?)
        .map_err(|_| ReferencePersistenceError::InvalidPersistedData)?;
    let execution_deadline = accepted_at
        .checked_add(execution_timeout)
        .ok_or(ReferencePersistenceError::InvalidPersistedData)?;
    let lookup_expires_at = accepted_at
        .checked_add(redemption.outcome_lookup_window_seconds)
        .ok_or(ReferencePersistenceError::InvalidPersistedData)?;
    let maximum_attempts = action.try_get::<i32, _>("maximum_attempts")?;
    sqlx::query(include_str!("postgres/queries/insert_redemption.sql"))
        .bind(&redemption_id)
        .bind(redemption.audience)
        .bind(redemption.action_reference)
        .bind(redemption.claimant_jkt)
        .bind(redemption.protected_action_type)
        .bind(redemption.action_policy)
        .bind(to_i64(accepted_at)?)
        .bind(to_i64(execution_deadline)?)
        .bind(maximum_attempts)
        .bind(to_i64(lookup_expires_at)?)
        .execute(&mut **transaction)
        .await?;
    sqlx::query(include_str!("postgres/queries/insert_pending_outcome.sql"))
        .bind(&redemption_id)
        .execute(&mut **transaction)
        .await?;
    sqlx::query(include_str!("postgres/queries/insert_execution_intent.sql"))
        .bind(&redemption_id)
        .bind(to_i64(accepted_at)?)
        .execute(&mut **transaction)
        .await?;
    Ok(redemption_id)
}

async fn select_redemption(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    redemption_id: &str,
) -> Result<RedemptionRecord, ReferencePersistenceError> {
    let row = sqlx::query(include_str!("postgres/queries/select_redemption.sql"))
        .bind(redemption_id)
        .fetch_one(&mut **transaction)
        .await?;
    let status = row.try_get::<String, _>("status")?;
    let outcome = match status.as_str() {
        "pending" => ProtectedActionOutcome::Pending,
        "succeeded" => ProtectedActionOutcome::Succeeded {
            result: serde_json::from_value::<ProtectedActionResult>(row.try_get("safe_result")?)
                .map_err(|_| ReferencePersistenceError::InvalidPersistedData)?,
        },
        "failed" => ProtectedActionOutcome::Failed {
            reason: row
                .try_get::<Option<String>, _>("safe_reason")?
                .ok_or(ReferencePersistenceError::InvalidPersistedData)?,
        },
        _ => return Err(ReferencePersistenceError::InvalidPersistedData),
    };
    Ok(RedemptionRecord {
        redemption_id: row.try_get("redemption_id")?,
        action_reference: row.try_get("action_reference")?,
        accepted_at_unix_seconds: u64::try_from(row.try_get::<i64, _>("accepted_at_unix_seconds")?)
            .map_err(|_| ReferencePersistenceError::InvalidPersistedData)?,
        outcome,
    })
}

fn to_i64(value: u64) -> Result<i64, ReferencePersistenceError> {
    i64::try_from(value).map_err(|_| ReferencePersistenceError::InvalidPersistedData)
}
