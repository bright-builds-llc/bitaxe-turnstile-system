use serde_json::{Value, json};
use uuid::Uuid;

use super::{PostgresGovernanceRepository, to_i64};
use crate::governance::{GovernanceContext, GovernanceError};

#[derive(Clone, Copy)]
pub(super) enum AuditEventType {
    RetentionPlanned,
    RetentionApplied,
    RetentionFailed,
    ExportStarted,
    ExportCompleted,
    ExportFailed,
    Pseudonymized,
    Deleted,
    RecoveryResumed,
}

impl AuditEventType {
    const fn as_str(self) -> &'static str {
        match self {
            Self::RetentionPlanned => "retention_planned",
            Self::RetentionApplied => "retention_applied",
            Self::RetentionFailed => "retention_failed",
            Self::ExportStarted => "export_started",
            Self::ExportCompleted => "export_completed",
            Self::ExportFailed => "export_failed",
            Self::Pseudonymized => "pseudonymized",
            Self::Deleted => "deleted",
            Self::RecoveryResumed => "recovery_resumed",
        }
    }
}

pub(super) struct NewAuditEvent<'a> {
    pub event_type: AuditEventType,
    pub operation_id: Uuid,
    pub maybe_manifest_digest: Option<&'a str>,
    pub counts: Value,
    pub duration_milliseconds: u64,
    pub outcome: &'a str,
    pub maybe_error_category: Option<&'a str>,
    pub context: GovernanceContext,
    pub maybe_snapshot_cutoff_unix_seconds: Option<u64>,
}

pub(super) async fn insert_audit_event(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    event: NewAuditEvent<'_>,
) -> Result<(), GovernanceError> {
    sqlx::query(include_str!("../queries/insert_audit_event.sql"))
        .bind(Uuid::new_v4())
        .bind(event.event_type.as_str())
        .bind(event.operation_id)
        .bind(event.maybe_manifest_digest)
        .bind(event.counts)
        .bind(to_i64(event.duration_milliseconds)?)
        .bind(event.outcome)
        .bind(event.maybe_error_category)
        .bind(event.context.as_str())
        .bind(
            event
                .maybe_snapshot_cutoff_unix_seconds
                .map(to_i64)
                .transpose()?,
        )
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

impl PostgresGovernanceRepository {
    pub(in crate::governance) async fn record_retention_failure(
        &self,
        job_id: Uuid,
        manifest_digest: &str,
        error_category: &str,
    ) -> Result<(), GovernanceError> {
        self.record_failure(
            AuditEventType::RetentionFailed,
            job_id,
            Some(manifest_digest),
            error_category,
        )
        .await
    }

    pub(in crate::governance) async fn record_export_failure(
        &self,
        export_id: Uuid,
        error_category: &str,
    ) -> Result<(), GovernanceError> {
        self.record_failure(
            AuditEventType::ExportFailed,
            export_id,
            None,
            error_category,
        )
        .await
    }

    async fn record_failure(
        &self,
        event_type: AuditEventType,
        operation_id: Uuid,
        maybe_manifest_digest: Option<&str>,
        error_category: &str,
    ) -> Result<(), GovernanceError> {
        let maybe_cutoff = self.operation_cutoff(operation_id).await?;
        let mut transaction = self.pool.begin().await?;
        insert_audit_event(
            &mut transaction,
            NewAuditEvent {
                event_type,
                operation_id,
                maybe_manifest_digest,
                counts: json!({}),
                duration_milliseconds: 0,
                outcome: "failed",
                maybe_error_category: Some(error_category),
                context: self.profile.context,
                maybe_snapshot_cutoff_unix_seconds: maybe_cutoff,
            },
        )
        .await?;
        transaction.commit().await?;
        Ok(())
    }

    async fn operation_cutoff(&self, operation_id: Uuid) -> Result<Option<u64>, GovernanceError> {
        let maybe_cutoff =
            sqlx::query_scalar::<_, i64>(include_str!("../queries/select_operation_cutoff.sql"))
                .bind(operation_id)
                .fetch_optional(&self.pool)
                .await?;
        maybe_cutoff.map(super::to_u64).transpose()
    }
}
