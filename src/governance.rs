//! Pure BWG data-governance policy and context-local operator interfaces.

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

pub mod cli;
mod postgres;

use postgres::PostgresGovernanceRepository;

/// Hosted identifying-retention default: 30 days.
pub const HOSTED_OPERATIONAL_RETENTION_SECONDS: u64 = 30 * 24 * 60 * 60;
/// Hosted tombstone and governance-audit default: 90 days.
pub const HOSTED_TOMBSTONE_RETENTION_SECONDS: u64 = 90 * 24 * 60 * 60;

/// The persistence context owned by one Service-Local Operator interface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GovernanceContext {
    GateAuthority,
    RelyingService,
}

impl GovernanceContext {
    /// Returns the stable storage and export name for this context.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::GateAuthority => "gate_authority",
            Self::RelyingService => "relying_service",
        }
    }
}

/// One context-owned class of BWG persistence records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GovernedRecordClass {
    ClaimantIssuanceProofReplay,
    SignedGatePass,
    AuthorityOperational,
    DpopProofReplay,
    ClaimantOutcomeProofReplay,
    PassConsumption,
    RelyingServiceOperational,
    GovernanceAudit,
}

impl GovernedRecordClass {
    fn retires_immediately_after_floor(self) -> bool {
        matches!(
            self,
            Self::ClaimantIssuanceProofReplay
                | Self::SignedGatePass
                | Self::DpopProofReplay
                | Self::ClaimantOutcomeProofReplay
                | Self::GovernanceAudit
        )
    }
}

/// The privacy-relevant form currently retained for a governed record.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetentionState {
    Identifying,
    Pseudonymized,
}

/// A context policy whose configured windows may extend protocol floors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetentionPolicy {
    operational_retention_seconds: u64,
    tombstone_retention_seconds: u64,
}

impl RetentionPolicy {
    /// Returns the hosted 30/90-day policy.
    pub const fn hosted_default() -> Self {
        Self {
            operational_retention_seconds: HOSTED_OPERATIONAL_RETENTION_SECONDS,
            tombstone_retention_seconds: HOSTED_TOMBSTONE_RETENTION_SECONDS,
        }
    }

    /// Parses a deployment policy, rejecting missing or inverted retention windows.
    pub fn new(
        operational_retention_seconds: u64,
        tombstone_retention_seconds: u64,
    ) -> Result<Self, GovernanceError> {
        if operational_retention_seconds < HOSTED_OPERATIONAL_RETENTION_SECONDS {
            return Err(GovernanceError::InvalidRetentionPolicy);
        }
        if tombstone_retention_seconds < HOSTED_TOMBSTONE_RETENTION_SECONDS
            || tombstone_retention_seconds < operational_retention_seconds
        {
            return Err(GovernanceError::InvalidRetentionPolicy);
        }
        Ok(Self {
            operational_retention_seconds,
            tombstone_retention_seconds,
        })
    }

    /// Configured identifying-retention duration.
    pub const fn operational_retention_seconds(self) -> u64 {
        self.operational_retention_seconds
    }

    /// Configured tombstone-retention duration measured from the terminal instant.
    pub const fn tombstone_retention_seconds(self) -> u64 {
        self.tombstone_retention_seconds
    }
}

/// One record whose exact protocol and configured Retention Floor is known.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetentionCandidate {
    record_class: GovernedRecordClass,
    state: RetentionState,
    retention_floor_unix_seconds: u64,
}

impl RetentionCandidate {
    /// Creates a candidate after its context has calculated the later of every applicable floor.
    pub const fn new(
        record_class: GovernedRecordClass,
        state: RetentionState,
        retention_floor_unix_seconds: u64,
    ) -> Self {
        Self {
            record_class,
            state,
            retention_floor_unix_seconds,
        }
    }
}

/// The irreversible transition selected by a Retention Job plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetentionAction {
    Pseudonymize,
    Delete,
}

impl RetentionAction {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Pseudonymize => "pseudonymize",
            Self::Delete => "delete",
        }
    }
}

/// One eligible transition emitted by the pure planner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlannedRetention {
    action: RetentionAction,
    reason: EligibilityReason,
}

impl PlannedRetention {
    /// Returns the planned irreversible transition.
    pub const fn action(self) -> RetentionAction {
        self.action
    }

    /// Returns the independently inspectable rule that made the transition eligible.
    pub const fn reason(self) -> EligibilityReason {
        self.reason
    }
}

/// The policy fact that made one planned transition eligible.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EligibilityReason {
    ProtocolRetentionFloorReached,
    OperationalWindowElapsed,
    TombstoneWindowElapsed,
}

/// Plans one candidate without performing I/O or changing the governed record.
pub fn plan_candidate(
    candidate: &RetentionCandidate,
    as_of_unix_seconds: u64,
    policy: RetentionPolicy,
) -> Result<Option<PlannedRetention>, GovernanceError> {
    RetentionPolicy::new(
        policy.operational_retention_seconds,
        policy.tombstone_retention_seconds,
    )?;
    if as_of_unix_seconds < candidate.retention_floor_unix_seconds {
        return Ok(None);
    }
    let (action, reason) = match candidate.state {
        RetentionState::Pseudonymized => (
            RetentionAction::Delete,
            EligibilityReason::TombstoneWindowElapsed,
        ),
        RetentionState::Identifying if candidate.record_class.retires_immediately_after_floor() => {
            (
                RetentionAction::Delete,
                EligibilityReason::ProtocolRetentionFloorReached,
            )
        }
        RetentionState::Identifying => (
            RetentionAction::Pseudonymize,
            EligibilityReason::OperationalWindowElapsed,
        ),
    };
    Ok(Some(PlannedRetention { action, reason }))
}

/// Durable lifecycle state of one context-local Retention Job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetentionJobStatus {
    Planned,
    Applying,
    Completed,
    Failed,
}

impl RetentionJobStatus {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Planned => "planned",
            Self::Applying => "applying",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }
}

/// Persisted, digest-bound result of a read-only-for-domain-records planning operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GovernanceManifest {
    job_id: String,
    context: GovernanceContext,
    as_of_unix_seconds: u64,
    policy: RetentionPolicy,
    status: RetentionJobStatus,
    eligible_items: u64,
    planned_counts: Vec<PlannedCount>,
    manifest_digest: String,
}

/// Aggregate of independently inspectable planned actions without governed record identifiers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlannedCount {
    record_class: GovernedRecordClass,
    action: RetentionAction,
    reason: EligibilityReason,
    count: u64,
}

impl GovernanceManifest {
    /// Durable identifier used by a later Destructive Apply.
    pub fn job_id(&self) -> &str {
        &self.job_id
    }

    /// SHA-256 digest binding the context, cutoff, policy, and ordered items.
    pub fn manifest_digest(&self) -> &str {
        &self.manifest_digest
    }
}

/// Context-local PostgreSQL governance application used by the operator CLI.
pub struct GovernanceApplication {
    context: GovernanceContext,
    repository: PostgresGovernanceRepository,
}

impl GovernanceApplication {
    /// Connects one operator role to only its owned schema and applies additive migrations.
    pub async fn connect(
        context: GovernanceContext,
        database_url: &str,
    ) -> Result<Self, GovernanceError> {
        let repository = PostgresGovernanceRepository::connect(context, database_url).await?;
        Ok(Self {
            context,
            repository,
        })
    }

    /// Plans eligible records without changing governed domain rows.
    pub async fn plan_retention(
        &self,
        as_of_unix_seconds: u64,
        policy: RetentionPolicy,
    ) -> Result<GovernanceManifest, GovernanceError> {
        RetentionPolicy::new(
            policy.operational_retention_seconds,
            policy.tombstone_retention_seconds,
        )?;
        if as_of_unix_seconds == 0 {
            return Err(GovernanceError::InvalidPlanningInstant);
        }
        self.repository
            .plan_retention(self.context, as_of_unix_seconds, policy)
            .await
    }

    /// Applies at most one digest-bound batch and returns its durable cursor.
    pub async fn apply_retention(
        &self,
        request: ApplyRetentionRequest,
    ) -> Result<ApplyRetentionResult, GovernanceError> {
        self.repository.apply_retention(self.context, request).await
    }
}

/// Validated authorization and bounds for one Destructive Apply invocation.
pub struct ApplyRetentionRequest {
    job_id: Uuid,
    manifest_digest: String,
    batch_size: u64,
}

impl ApplyRetentionRequest {
    /// Parses an operator request and fails before persistence access unless every guard is present.
    pub fn new(
        job_id: &str,
        manifest_digest: &str,
        batch_size: u64,
        destructive_enabled: bool,
        confirmed: bool,
    ) -> Result<Self, GovernanceError> {
        if !destructive_enabled {
            return Err(GovernanceError::DestructiveApplyDisabled);
        }
        if !confirmed {
            return Err(GovernanceError::DestructiveConfirmationRequired);
        }
        if batch_size == 0 || batch_size > 1_000 {
            return Err(GovernanceError::InvalidBatchSize);
        }
        if manifest_digest.len() != 64
            || !manifest_digest.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(GovernanceError::InvalidManifestDigest);
        }
        Ok(Self {
            job_id: Uuid::parse_str(job_id).map_err(|_| GovernanceError::InvalidJobId)?,
            manifest_digest: manifest_digest.to_owned(),
            batch_size,
        })
    }
}

/// Observable result of one bounded Destructive Apply invocation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ApplyRetentionResult {
    job_id: String,
    context: GovernanceContext,
    manifest_digest: String,
    status: RetentionJobStatus,
    cursor: u64,
    deleted_items: u64,
    pseudonymized_items: u64,
}

/// Data-governance policy or persistence failure.
#[derive(Debug, Error)]
pub enum GovernanceError {
    #[error("retention policy cannot shorten the hosted 30/90-day defaults or invert its windows")]
    InvalidRetentionPolicy,
    #[error("retention planning instant must be positive")]
    InvalidPlanningInstant,
    #[error("destructive retention apply is disabled")]
    DestructiveApplyDisabled,
    #[error("destructive retention apply requires explicit confirmation")]
    DestructiveConfirmationRequired,
    #[error("retention batch size must be between 1 and 1000")]
    InvalidBatchSize,
    #[error("retention job identifier is invalid")]
    InvalidJobId,
    #[error("governance manifest digest must be 64 hexadecimal characters")]
    InvalidManifestDigest,
    #[error("governance manifest digest does not match the planned job")]
    ManifestDigestMismatch,
    #[error("retention job is unavailable in this persistence context")]
    UnknownRetentionJob,
    #[error("governed records changed after planning; create and review a new plan")]
    StaleRetentionPlan,
    #[error("persisted governance data exceeds supported numeric bounds")]
    InvalidPersistedData,
    #[error("governance database operation failed")]
    Database(#[from] sqlx::Error),
    #[error("governance migration failed")]
    Migration(#[from] sqlx::migrate::MigrateError),
    #[error("governance manifest serialization failed")]
    ManifestSerialization(#[from] serde_json::Error),
}
