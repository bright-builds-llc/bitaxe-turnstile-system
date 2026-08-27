use sqlx::{PgPool, Row as _, postgres::PgRow};

use super::unix_seconds_to_i64;
use crate::{
    authority_persistence::{AuthorityPersistenceError, PersistPoolOfferReplacement},
    pool_offer::{
        PoolOffer, PoolOfferChange, PoolOfferReplacementDecision, PoolOfferReplacementStatus,
    },
    progress::WorkSessionId,
};

pub(super) async fn persist(
    pool: &PgPool,
    input: PersistPoolOfferReplacement<'_>,
) -> Result<PoolOfferReplacementDecision, AuthorityPersistenceError> {
    let mut transaction = pool.begin().await?;
    let status = match input.change {
        PoolOfferChange::Equivalent => PoolOfferReplacementStatus::Equivalent,
        PoolOfferChange::MateriallyChanged { .. } => {
            PoolOfferReplacementStatus::PendingReconfirmation
        }
    };
    let inserted = sqlx::query(include_str!("queries/insert_pool_offer_replacement.sql"))
        .bind(input.replaced_session_id.as_str())
        .bind(input.candidate_session_id.as_str())
        .bind(input.challenge_id.as_str())
        .bind(status_string(status))
        .bind(
            serde_json::to_value(input.prior_offer)
                .map_err(|_| AuthorityPersistenceError::InvalidPersistedData)?,
        )
        .bind(
            serde_json::to_value(input.candidate_offer)
                .map_err(|_| AuthorityPersistenceError::InvalidPersistedData)?,
        )
        .bind(input.candidate_signature)
        .bind(input.candidate_set_digest)
        .bind(
            serde_json::to_value(input.change)
                .map_err(|_| AuthorityPersistenceError::InvalidPersistedData)?,
        )
        .bind(unix_seconds_to_i64(input.now)?)
        .fetch_optional(&mut *transaction)
        .await?;
    let row = match inserted {
        Some(row) => row,
        None => {
            sqlx::query(include_str!("queries/select_pool_offer_replacement.sql"))
                .bind(input.replaced_session_id.as_str())
                .fetch_one(&mut *transaction)
                .await?
        }
    };
    let decision = decision_from_row(&row)?;
    if decision.prior_offer() != input.prior_offer
        || decision.candidate_offer() != input.candidate_offer
        || decision.change() != input.change
        || row.try_get::<String, _>("candidate_session_id")? != input.candidate_session_id.as_str()
        || row.try_get::<String, _>("candidate_set_digest")? != input.candidate_set_digest
    {
        return Err(AuthorityPersistenceError::ConflictingPoolOfferReplacement);
    }
    if status == PoolOfferReplacementStatus::Equivalent {
        super::pool_selection::replace_work_session_in_transaction(
            &mut transaction,
            input.replaced_session_id,
            input.candidate_session_id,
            input.now,
        )
        .await?;
    } else {
        let maybe_existing = sqlx::query(include_str!(
            "queries/select_work_session_replacement_by_predecessor.sql"
        ))
        .bind(input.replaced_session_id.as_str())
        .fetch_optional(&mut *transaction)
        .await?;
        if maybe_existing.is_some() {
            return Err(AuthorityPersistenceError::ConflictingWorkSessionReplacement);
        }
    }
    transaction.commit().await?;
    Ok(decision)
}

fn decision_from_row(
    row: &PgRow,
) -> Result<PoolOfferReplacementDecision, AuthorityPersistenceError> {
    let status = parse_status(row.try_get("status")?)?;
    let change = serde_json::from_value::<PoolOfferChange>(row.try_get("change")?)
        .map_err(|_| AuthorityPersistenceError::InvalidPersistedData)?;
    let candidate_session_id =
        WorkSessionId::try_from(row.try_get::<String, _>("candidate_session_id")?)?;
    let maybe_replacement_session_id = match status {
        PoolOfferReplacementStatus::Equivalent => Some(candidate_session_id),
        PoolOfferReplacementStatus::PendingReconfirmation => None,
    };
    PoolOfferReplacementDecision::persisted(
        WorkSessionId::try_from(row.try_get::<String, _>("replaced_session_id")?)?,
        maybe_replacement_session_id,
        serde_json::from_value::<PoolOffer>(row.try_get("prior_offer")?)
            .map_err(|_| AuthorityPersistenceError::InvalidPersistedData)?,
        serde_json::from_value::<PoolOffer>(row.try_get("candidate_offer")?)
            .map_err(|_| AuthorityPersistenceError::InvalidPersistedData)?,
        row.try_get("candidate_signature")?,
        change,
    )
    .map_err(|_| AuthorityPersistenceError::InvalidPersistedData)
}

fn status_string(status: PoolOfferReplacementStatus) -> &'static str {
    match status {
        PoolOfferReplacementStatus::Equivalent => "equivalent",
        PoolOfferReplacementStatus::PendingReconfirmation => "pending_reconfirmation",
    }
}

fn parse_status(value: &str) -> Result<PoolOfferReplacementStatus, AuthorityPersistenceError> {
    match value {
        "equivalent" => Ok(PoolOfferReplacementStatus::Equivalent),
        "pending_reconfirmation" => Ok(PoolOfferReplacementStatus::PendingReconfirmation),
        _ => Err(AuthorityPersistenceError::InvalidPersistedData),
    }
}
