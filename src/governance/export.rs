use std::time::{SystemTime, UNIX_EPOCH};

use uuid::Uuid;

use super::{GovernanceApplication, GovernanceError, PseudonymizationKey};

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
                self.repository
                    .record_export_failure(export_id, error.audit_category())
                    .await
                    .map_err(|_| GovernanceError::AuditPersistenceFailed)?;
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
                self.repository
                    .record_export_failure(export_id, error.audit_category())
                    .await
                    .map_err(|_| GovernanceError::AuditPersistenceFailed)?;
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
