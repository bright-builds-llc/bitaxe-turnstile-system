use super::{PlannedItem, authority_retention, delete_protocol_material, reference_retention};
use crate::governance::{
    EligibilityReason, GovernanceContext, GovernanceError, PseudonymizationKey, RetentionAction,
    RetentionPolicy,
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
                delete_protocol_material(transaction, context, item, as_of_unix_seconds).await?,
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
