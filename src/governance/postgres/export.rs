use std::{collections::BTreeMap, time::Instant};

use serde_json::json;
use sqlx::Row as _;
use uuid::Uuid;

use super::{
    PostgresGovernanceRepository,
    audit::{AuditEventType, NewAuditEvent, insert_audit_event},
    to_i64, to_u64,
};
use crate::governance::{
    ExportResumeRequest, ExportStartRequest, GovernanceError, GovernanceExportPage,
    export::{ExportSource, export_line, freeze_export, manifest_line},
};

struct ExportJob {
    snapshot_cutoff_unix_seconds: u64,
    total_items: u64,
    total_bytes: u64,
    content_sha256: String,
    counts: BTreeMap<String, u64>,
}

impl PostgresGovernanceRepository {
    pub(in crate::governance) async fn start_export(
        &self,
        request: ExportStartRequest,
    ) -> Result<GovernanceExportPage, GovernanceError> {
        let started = Instant::now();
        let export_id = request.export_id;
        let mut transaction = self.pool.begin().await?;
        insert_audit_event(
            &mut transaction,
            NewAuditEvent {
                event_type: AuditEventType::ExportStarted,
                operation_id: export_id,
                maybe_manifest_digest: None,
                counts: json!({ "records": 0 }),
                duration_milliseconds: elapsed_milliseconds(started)?,
                outcome: "started",
                maybe_error_category: None,
                context: self.profile.context,
                maybe_snapshot_cutoff_unix_seconds: Some(request.snapshot_cutoff_unix_seconds),
            },
        )
        .await?;
        let sources = sqlx::query(self.profile.export_sources_query)
            .bind(to_i64(request.snapshot_cutoff_unix_seconds)?)
            .fetch_all(&mut *transaction)
            .await?
            .into_iter()
            .map(|source| {
                Ok(ExportSource {
                    record_type: source.try_get("record_type")?,
                    source_key: source.try_get("source_key")?,
                    payload: source.try_get("payload")?,
                })
            })
            .collect::<Result<Vec<_>, GovernanceError>>()?;
        let frozen = freeze_export(
            self.profile.context,
            export_id,
            request.snapshot_cutoff_unix_seconds,
            &request.pseudonymization_key,
            sources,
        )?;
        let total_items =
            u64::try_from(frozen.items.len()).map_err(|_| GovernanceError::InvalidPersistedData)?;
        sqlx::query(include_str!("../queries/insert_export_job.sql"))
            .bind(export_id)
            .bind(to_i64(request.snapshot_cutoff_unix_seconds)?)
            .bind(to_i64(total_items)?)
            .bind(to_i64(frozen.total_bytes)?)
            .bind(&frozen.content_sha256)
            .bind(serde_json::to_value(&frozen.counts)?)
            .execute(&mut *transaction)
            .await?;
        for (index, item) in frozen.items.iter().enumerate() {
            let sequence =
                u64::try_from(index + 1).map_err(|_| GovernanceError::InvalidPersistedData)?;
            sqlx::query(include_str!("../queries/insert_export_item.sql"))
                .bind(export_id)
                .bind(to_i64(sequence)?)
                .bind(&item.record_type)
                .bind(&item.payload)
                .execute(&mut *transaction)
                .await?;
        }
        transaction.commit().await?;
        self.export_page(
            export_id,
            0,
            request.page_size,
            Some(ExportJob {
                snapshot_cutoff_unix_seconds: request.snapshot_cutoff_unix_seconds,
                total_items,
                total_bytes: frozen.total_bytes,
                content_sha256: frozen.content_sha256,
                counts: frozen.counts,
            }),
        )
        .await
    }

    pub(in crate::governance) async fn resume_export(
        &self,
        request: ExportResumeRequest,
    ) -> Result<GovernanceExportPage, GovernanceError> {
        self.export_page(
            request.export_id,
            request.after_sequence,
            request.page_size,
            None,
        )
        .await
    }

    async fn export_page(
        &self,
        export_id: Uuid,
        after_sequence: u64,
        page_size: u64,
        maybe_job: Option<ExportJob>,
    ) -> Result<GovernanceExportPage, GovernanceError> {
        let started = Instant::now();
        let mut transaction = self.pool.begin().await?;
        let job = match maybe_job {
            Some(job) => job,
            None => load_export_job(&mut transaction, export_id).await?,
        };
        if after_sequence > job.total_items {
            return Err(GovernanceError::InvalidExportCursor);
        }
        if after_sequence > 0 {
            insert_audit_event(
                &mut transaction,
                NewAuditEvent {
                    event_type: AuditEventType::RecoveryResumed,
                    operation_id: export_id,
                    maybe_manifest_digest: Some(&job.content_sha256),
                    counts: json!({ "cursor": after_sequence }),
                    duration_milliseconds: elapsed_milliseconds(started)?,
                    outcome: "resumed",
                    maybe_error_category: None,
                    context: self.profile.context,
                    maybe_snapshot_cutoff_unix_seconds: Some(job.snapshot_cutoff_unix_seconds),
                },
            )
            .await?;
        }
        let rows = sqlx::query(include_str!("../queries/select_export_page.sql"))
            .bind(export_id)
            .bind(to_i64(after_sequence)?)
            .bind(to_i64(page_size)?)
            .fetch_all(&mut *transaction)
            .await?;
        let mut lines = rows
            .into_iter()
            .map(|row| {
                export_line(
                    self.profile.context,
                    export_id,
                    job.snapshot_cutoff_unix_seconds,
                    to_u64(row.try_get("sequence")?)?,
                    &row.try_get::<String, _>("record_type")?,
                    row.try_get("payload")?,
                )
            })
            .collect::<Result<Vec<_>, GovernanceError>>()?;
        let returned =
            u64::try_from(lines.len()).map_err(|_| GovernanceError::InvalidPersistedData)?;
        if after_sequence + returned >= job.total_items {
            lines.push(manifest_line(
                self.profile.context,
                export_id,
                job.snapshot_cutoff_unix_seconds,
                job.total_items,
                job.total_bytes,
                &job.content_sha256,
                job.counts.clone(),
            )?);
            let completed = sqlx::query(include_str!("../queries/complete_export_job.sql"))
                .bind(export_id)
                .execute(&mut *transaction)
                .await?;
            if completed.rows_affected() == 1 {
                insert_audit_event(
                    &mut transaction,
                    NewAuditEvent {
                        event_type: AuditEventType::ExportCompleted,
                        operation_id: export_id,
                        maybe_manifest_digest: Some(&job.content_sha256),
                        counts: json!({
                            "records": job.total_items,
                            "bytes": job.total_bytes
                        }),
                        duration_milliseconds: elapsed_milliseconds(started)?,
                        outcome: "completed",
                        maybe_error_category: None,
                        context: self.profile.context,
                        maybe_snapshot_cutoff_unix_seconds: Some(job.snapshot_cutoff_unix_seconds),
                    },
                )
                .await?;
            }
        }
        transaction.commit().await?;
        Ok(GovernanceExportPage { lines })
    }
}

async fn load_export_job(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    export_id: Uuid,
) -> Result<ExportJob, GovernanceError> {
    let maybe_row = sqlx::query(include_str!("../queries/select_export_job.sql"))
        .bind(export_id)
        .fetch_optional(&mut **transaction)
        .await?;
    let Some(row) = maybe_row else {
        return Err(GovernanceError::UnknownExport);
    };
    let counts = serde_json::from_value::<BTreeMap<String, u64>>(row.try_get("counts")?)?;
    Ok(ExportJob {
        snapshot_cutoff_unix_seconds: to_u64(row.try_get("snapshot_cutoff_unix_seconds")?)?,
        total_items: to_u64(row.try_get("total_items")?)?,
        total_bytes: to_u64(row.try_get("total_bytes")?)?,
        content_sha256: row.try_get("content_sha256")?,
        counts,
    })
}

fn elapsed_milliseconds(started: Instant) -> Result<u64, GovernanceError> {
    u64::try_from(started.elapsed().as_millis()).map_err(|_| GovernanceError::InvalidPersistedData)
}
