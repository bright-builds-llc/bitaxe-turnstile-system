use std::{collections::BTreeMap, time::Instant};

use serde::Serialize;
use serde_json::{Value, json};
use sqlx::Row as _;
use uuid::Uuid;

use super::{
    PostgresGovernanceRepository,
    audit::{AuditEventType, NewAuditEvent, insert_audit_event},
    sha256_hex, to_i64, to_u64,
};
use crate::governance::{
    ExportResumeRequest, ExportStartRequest, GovernanceContext, GovernanceError,
    GovernanceExportPage, GovernedRecordClass, pseudonymize_record,
};

#[derive(Serialize)]
struct ExportEnvelope<'a> {
    schema_version: &'static str,
    context: GovernanceContext,
    export_id: String,
    snapshot_cutoff_unix_seconds: u64,
    sequence: u64,
    record_type: &'a str,
    payload: Value,
}

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
            },
        )
        .await?;
        let sources = sqlx::query(self.profile.export_sources_query)
            .bind(to_i64(request.snapshot_cutoff_unix_seconds)?)
            .fetch_all(&mut *transaction)
            .await?;
        let mut lines = Vec::with_capacity(sources.len());
        let mut counts = BTreeMap::new();
        for (index, source) in sources.into_iter().enumerate() {
            let record_type = source.try_get::<String, _>("record_type")?;
            let source_key = source.try_get::<String, _>("source_key")?;
            let mut payload = source.try_get::<Value, _>("payload")?;
            let record_pseudonym = pseudonymize_record(
                &request.pseudonymization_key,
                self.profile.context,
                export_record_class(self.profile.context),
                &source_key,
            );
            let payload_object = payload
                .as_object_mut()
                .ok_or(GovernanceError::InvalidPersistedData)?;
            payload_object.insert(
                "record_pseudonym".to_owned(),
                Value::String(record_pseudonym),
            );
            let sequence =
                u64::try_from(index + 1).map_err(|_| GovernanceError::InvalidPersistedData)?;
            let mut line = serde_json::to_vec(&ExportEnvelope {
                schema_version: "bwg-governance-v1",
                context: self.profile.context,
                export_id: export_id.to_string(),
                snapshot_cutoff_unix_seconds: request.snapshot_cutoff_unix_seconds,
                sequence,
                record_type: &record_type,
                payload,
            })?;
            line.push(b'\n');
            *counts.entry(record_type).or_insert(0) += 1;
            lines.push(line);
        }
        let content = lines.concat();
        let total_items =
            u64::try_from(lines.len()).map_err(|_| GovernanceError::InvalidPersistedData)?;
        let total_bytes =
            u64::try_from(content.len()).map_err(|_| GovernanceError::InvalidPersistedData)?;
        let content_sha256 = sha256_hex(&content);
        sqlx::query(include_str!("../queries/insert_export_job.sql"))
            .bind(export_id)
            .bind(to_i64(request.snapshot_cutoff_unix_seconds)?)
            .bind(to_i64(total_items)?)
            .bind(to_i64(total_bytes)?)
            .bind(&content_sha256)
            .bind(serde_json::to_value(&counts)?)
            .execute(&mut *transaction)
            .await?;
        for (index, line) in lines.iter().enumerate() {
            let sequence =
                u64::try_from(index + 1).map_err(|_| GovernanceError::InvalidPersistedData)?;
            sqlx::query(include_str!("../queries/insert_export_item.sql"))
                .bind(export_id)
                .bind(to_i64(sequence)?)
                .bind(line)
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
                total_bytes,
                content_sha256,
                counts,
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
        let rows = sqlx::query(include_str!("../queries/select_export_page.sql"))
            .bind(export_id)
            .bind(to_i64(after_sequence)?)
            .bind(to_i64(page_size)?)
            .fetch_all(&mut *transaction)
            .await?;
        let mut lines = rows
            .into_iter()
            .map(|row| row.try_get::<Vec<u8>, _>("line_bytes").map_err(Into::into))
            .collect::<Result<Vec<_>, GovernanceError>>()?;
        let returned =
            u64::try_from(lines.len()).map_err(|_| GovernanceError::InvalidPersistedData)?;
        if after_sequence + returned >= job.total_items {
            let manifest_sequence = job
                .total_items
                .checked_add(1)
                .ok_or(GovernanceError::InvalidPersistedData)?;
            let mut manifest = serde_json::to_vec(&ExportEnvelope {
                schema_version: "bwg-governance-v1",
                context: self.profile.context,
                export_id: export_id.to_string(),
                snapshot_cutoff_unix_seconds: job.snapshot_cutoff_unix_seconds,
                sequence: manifest_sequence,
                record_type: "governance_manifest",
                payload: json!({
                    "counts": job.counts,
                    "total_items": job.total_items,
                    "total_bytes": job.total_bytes,
                    "content_sha256": job.content_sha256,
                }),
            })?;
            manifest.push(b'\n');
            lines.push(manifest);
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

const fn export_record_class(context: GovernanceContext) -> GovernedRecordClass {
    match context {
        GovernanceContext::GateAuthority => GovernedRecordClass::AuthorityOperational,
        GovernanceContext::RelyingService => GovernedRecordClass::RelyingServiceOperational,
    }
}

fn elapsed_milliseconds(started: Instant) -> Result<u64, GovernanceError> {
    u64::try_from(started.elapsed().as_millis()).map_err(|_| GovernanceError::InvalidPersistedData)
}
