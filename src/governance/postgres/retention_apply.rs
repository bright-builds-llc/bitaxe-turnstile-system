use uuid::Uuid;

use super::{PlannedItem, authority_retention, reference_retention, to_i64};
use crate::governance::{
    EligibilityReason, GovernanceContext, GovernanceError, GovernedRecordClass,
    PseudonymizationKey, RetentionAction, RetentionPolicy,
};

pub(super) enum AppliedTransition {
    Deleted(u64),
    Pseudonymized(u64),
}

impl AppliedTransition {
    pub(super) const fn affected(&self) -> u64 {
        match self {
            Self::Deleted(affected) | Self::Pseudonymized(affected) => *affected,
        }
    }
}

pub(super) async fn apply_transition(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    context: GovernanceContext,
    item: &PlannedItem,
    as_of_unix_seconds: u64,
    policy: RetentionPolicy,
    maybe_key: Option<&PseudonymizationKey>,
) -> Result<AppliedTransition, GovernanceError> {
    let applied = match (context, item.action, item.reason) {
        (_, RetentionAction::Delete, EligibilityReason::ProtocolRetentionFloorReached) => {
            AppliedTransition::Deleted(
                delete_protocol_material(transaction, context, item, as_of_unix_seconds, policy)
                    .await?,
            )
        }
        (
            GovernanceContext::GateAuthority,
            RetentionAction::Pseudonymize,
            EligibilityReason::OperationalWindowElapsed,
        ) => AppliedTransition::Pseudonymized(
            authority_retention::pseudonymize_authority_aggregate(
                transaction,
                context,
                item,
                as_of_unix_seconds,
                policy,
                required_key(maybe_key)?,
            )
            .await?,
        ),
        (
            GovernanceContext::RelyingService,
            RetentionAction::Pseudonymize,
            EligibilityReason::OperationalWindowElapsed,
        ) => AppliedTransition::Pseudonymized(
            reference_retention::pseudonymize_reference_record(
                transaction,
                context,
                item,
                as_of_unix_seconds,
                policy,
                required_key(maybe_key)?,
            )
            .await?,
        ),
        (
            GovernanceContext::GateAuthority,
            RetentionAction::Delete,
            EligibilityReason::TombstoneWindowElapsed,
        ) => AppliedTransition::Deleted(
            authority_retention::delete_authority_tombstone(
                transaction,
                context,
                item,
                as_of_unix_seconds,
            )
            .await?,
        ),
        (
            GovernanceContext::RelyingService,
            RetentionAction::Delete,
            EligibilityReason::TombstoneWindowElapsed,
        ) => AppliedTransition::Deleted(
            reference_retention::delete_reference_tombstone(
                transaction,
                context,
                item,
                as_of_unix_seconds,
            )
            .await?,
        ),
        (
            GovernanceContext::GateAuthority,
            RetentionAction::Delete,
            EligibilityReason::OverdueRetentionWindowElapsed,
        ) => AppliedTransition::Deleted(
            authority_retention::delete_overdue_authority_aggregate(
                transaction,
                context,
                item,
                as_of_unix_seconds,
                policy,
            )
            .await?,
        ),
        (
            GovernanceContext::RelyingService,
            RetentionAction::Delete,
            EligibilityReason::OverdueRetentionWindowElapsed,
        ) => AppliedTransition::Deleted(
            reference_retention::delete_overdue_reference_record(
                transaction,
                context,
                item,
                as_of_unix_seconds,
                policy,
            )
            .await?,
        ),
        _ => return Err(GovernanceError::InvalidPersistedData),
    };
    Ok(applied)
}

fn required_key(
    maybe_key: Option<&PseudonymizationKey>,
) -> Result<&PseudonymizationKey, GovernanceError> {
    maybe_key.ok_or(GovernanceError::MissingPseudonymizationKey)
}

async fn delete_protocol_material(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    context: GovernanceContext,
    item: &PlannedItem,
    as_of_unix_seconds: u64,
    policy: RetentionPolicy,
) -> Result<u64, GovernanceError> {
    if !super::record_class_allowed_in_context(item.record_class, context) {
        return Err(GovernanceError::InvalidPersistedData);
    }
    let result = match item.record_class {
        GovernedRecordClass::GovernanceExportSnapshot => {
            let export_id = Uuid::parse_str(&item.record_key)
                .map_err(|_| GovernanceError::InvalidPersistedData)?;
            let created_at = item
                .retention_floor_unix_seconds
                .checked_sub(policy.tombstone_retention_seconds())
                .ok_or(GovernanceError::InvalidPersistedData)?;
            sqlx::query(include_str!("../queries/delete_governance_export.sql"))
                .bind(export_id)
                .bind(to_i64(created_at)?)
                .bind(to_i64(as_of_unix_seconds)?)
                .execute(&mut **transaction)
                .await?
        }
        GovernedRecordClass::GovernanceAudit => {
            let event_id = Uuid::parse_str(&item.record_key)
                .map_err(|_| GovernanceError::InvalidPersistedData)?;
            let occurred_at = item
                .retention_floor_unix_seconds
                .checked_sub(policy.tombstone_retention_seconds())
                .ok_or(GovernanceError::InvalidPersistedData)?;
            sqlx::query(include_str!("../queries/delete_governance_audit.sql"))
                .bind(event_id)
                .bind(to_i64(occurred_at)?)
                .bind(to_i64(as_of_unix_seconds)?)
                .execute(&mut **transaction)
                .await?
        }
        GovernedRecordClass::SignedGatePass => {
            sqlx::query(include_str!("../queries/clear_signed_gate_pass.sql"))
                .bind(&item.record_key)
                .bind(to_i64(item.retention_floor_unix_seconds)?)
                .bind(to_i64(as_of_unix_seconds)?)
                .execute(&mut **transaction)
                .await?
        }
        GovernedRecordClass::TrustedConsentReceipt => {
            sqlx::query(include_str!("../queries/clear_trusted_consent_receipt.sql"))
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

const fn replay_delete_query(
    record_class: GovernedRecordClass,
) -> Result<&'static str, GovernanceError> {
    match record_class {
        GovernedRecordClass::ClaimantIssuanceProofReplay => {
            Ok(include_str!("../queries/delete_issuance_proof.sql"))
        }
        GovernedRecordClass::DpopProofReplay => {
            Ok(include_str!("../queries/delete_dpop_proof.sql"))
        }
        GovernedRecordClass::ClaimantOutcomeProofReplay => {
            Ok(include_str!("../queries/delete_outcome_proof.sql"))
        }
        _ => Err(GovernanceError::InvalidPersistedData),
    }
}
