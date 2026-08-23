use std::{
    collections::BTreeMap,
    time::{SystemTime, UNIX_EPOCH},
};

use ring::digest::{SHA256, digest};
use serde::Serialize;
use serde_json::{Value, json};
use uuid::Uuid;

use super::{GovernanceApplication, GovernanceError, PseudonymizationKey};

#[cfg(test)]
mod tests;

#[derive(Serialize)]
struct ExportEnvelope<'a> {
    schema_version: &'static str,
    context: super::GovernanceContext,
    export_id: String,
    snapshot_cutoff_unix_seconds: u64,
    sequence: u64,
    record_type: &'a str,
    payload: Value,
}

pub(super) struct ExportSource {
    pub record_type: String,
    pub source_key: String,
    pub payload: Value,
}

pub(super) struct FrozenExportItem {
    pub record_type: String,
    pub payload: Value,
}

pub(super) struct FrozenExport {
    pub items: Vec<FrozenExportItem>,
    pub counts: BTreeMap<String, u64>,
    pub total_bytes: u64,
    pub content_sha256: String,
}

pub(super) fn freeze_export(
    context: super::GovernanceContext,
    export_id: Uuid,
    snapshot_cutoff_unix_seconds: u64,
    key: &PseudonymizationKey,
    sources: Vec<ExportSource>,
) -> Result<FrozenExport, GovernanceError> {
    let mut items = Vec::with_capacity(sources.len());
    let mut counts = BTreeMap::new();
    let mut content = Vec::new();
    for (index, source) in sources.into_iter().enumerate() {
        let mut payload = source.payload;
        let payload_object = payload
            .as_object_mut()
            .ok_or(GovernanceError::InvalidPersistedData)?;
        payload_object.insert(
            "record_pseudonym".to_owned(),
            Value::String(super::pseudonymize_record(
                key,
                context,
                export_record_class(context),
                &source.source_key,
            )),
        );
        let sequence =
            u64::try_from(index + 1).map_err(|_| GovernanceError::InvalidPersistedData)?;
        content.extend_from_slice(&export_line(
            context,
            export_id,
            snapshot_cutoff_unix_seconds,
            sequence,
            &source.record_type,
            payload.clone(),
        )?);
        *counts.entry(source.record_type.clone()).or_insert(0) += 1;
        items.push(FrozenExportItem {
            record_type: source.record_type,
            payload,
        });
    }
    Ok(FrozenExport {
        items,
        counts,
        total_bytes: u64::try_from(content.len())
            .map_err(|_| GovernanceError::InvalidPersistedData)?,
        content_sha256: sha256_hex(&content),
    })
}

pub(super) fn export_line(
    context: super::GovernanceContext,
    export_id: Uuid,
    snapshot_cutoff_unix_seconds: u64,
    sequence: u64,
    record_type: &str,
    payload: Value,
) -> Result<Vec<u8>, GovernanceError> {
    let mut line = serde_json::to_vec(&ExportEnvelope {
        schema_version: "bwg-governance-v1",
        context,
        export_id: export_id.to_string(),
        snapshot_cutoff_unix_seconds,
        sequence,
        record_type,
        payload,
    })?;
    line.push(b'\n');
    Ok(line)
}

pub(super) fn manifest_line(
    context: super::GovernanceContext,
    export_id: Uuid,
    snapshot_cutoff_unix_seconds: u64,
    total_items: u64,
    total_bytes: u64,
    content_sha256: &str,
    counts: BTreeMap<String, u64>,
) -> Result<Vec<u8>, GovernanceError> {
    export_line(
        context,
        export_id,
        snapshot_cutoff_unix_seconds,
        total_items
            .checked_add(1)
            .ok_or(GovernanceError::InvalidPersistedData)?,
        "governance_manifest",
        json!({
            "counts": counts,
            "total_items": total_items,
            "total_bytes": total_bytes,
            "content_sha256": content_sha256,
        }),
    )
}

fn sha256_hex(bytes: &[u8]) -> String {
    digest(&SHA256, bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

const fn export_record_class(context: super::GovernanceContext) -> super::GovernedRecordClass {
    match context {
        super::GovernanceContext::GateAuthority => super::GovernedRecordClass::AuthorityOperational,
        super::GovernanceContext::RelyingService => {
            super::GovernedRecordClass::RelyingServiceOperational
        }
    }
}

pub(super) struct ExportStartRequest {
    pub(super) export_id: Uuid,
    pub(super) snapshot_cutoff_unix_seconds: u64,
    pub(super) page_size: u64,
    pub(super) pseudonymization_key: PseudonymizationKey,
}

impl ExportStartRequest {
    pub(super) fn new(
        snapshot_cutoff_unix_seconds: u64,
        page_size: u64,
        pseudonymization_key: &str,
    ) -> Result<Self, GovernanceError> {
        validate_page_size(page_size)?;
        if snapshot_cutoff_unix_seconds == 0 {
            return Err(GovernanceError::InvalidPlanningInstant);
        }
        Ok(Self {
            export_id: Uuid::new_v4(),
            snapshot_cutoff_unix_seconds,
            page_size,
            pseudonymization_key: PseudonymizationKey::parse(pseudonymization_key)?,
        })
    }
}

pub(super) struct ExportResumeRequest {
    pub(super) export_id: Uuid,
    pub(super) after_sequence: u64,
    pub(super) page_size: u64,
}

impl ExportResumeRequest {
    pub(super) fn new(
        export_id: &str,
        after_sequence: u64,
        page_size: u64,
    ) -> Result<Self, GovernanceError> {
        validate_page_size(page_size)?;
        Ok(Self {
            export_id: Uuid::parse_str(export_id).map_err(|_| GovernanceError::InvalidExportId)?,
            after_sequence,
            page_size,
        })
    }
}

pub(super) struct GovernanceExportPage {
    pub(super) lines: Vec<Vec<u8>>,
}

impl GovernanceExportPage {
    pub(super) fn into_lines(self) -> Vec<Vec<u8>> {
        self.lines
    }
}

impl GovernanceApplication {
    pub(super) async fn start_export(
        &self,
        request: ExportStartRequest,
    ) -> Result<GovernanceExportPage, GovernanceError> {
        let trusted_now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| GovernanceError::SystemClockUnavailable)?
            .as_secs();
        if request.snapshot_cutoff_unix_seconds > trusted_now {
            return Err(GovernanceError::PlanningInstantInFuture);
        }
        let export_id = request.export_id;
        match self.repository.start_export(request).await {
            Ok(page) => Ok(page),
            Err(error) => {
                if let Err(audit_error) = self
                    .repository
                    .record_export_failure(export_id, error.audit_category())
                    .await
                {
                    return Err(GovernanceError::OperationAndAuditFailure {
                        operation: Box::new(error),
                        audit: Box::new(audit_error),
                    });
                }
                Err(error)
            }
        }
    }

    pub(super) async fn resume_export(
        &self,
        request: ExportResumeRequest,
    ) -> Result<GovernanceExportPage, GovernanceError> {
        let export_id = request.export_id;
        match self.repository.resume_export(request).await {
            Ok(page) => Ok(page),
            Err(error) => {
                if let Err(audit_error) = self
                    .repository
                    .record_export_failure(export_id, error.audit_category())
                    .await
                {
                    return Err(GovernanceError::OperationAndAuditFailure {
                        operation: Box::new(error),
                        audit: Box::new(audit_error),
                    });
                }
                Err(error)
            }
        }
    }
}

fn validate_page_size(page_size: u64) -> Result<(), GovernanceError> {
    if page_size == 0 || page_size > 1_000 {
        return Err(GovernanceError::InvalidExportPageSize);
    }
    Ok(())
}
