use sqlx::{PgPool, Row as _, postgres::PgRow};

use super::unix_seconds_to_i64;
use crate::{
    authority_persistence::{
        AuthorityPersistenceError, PendingMaterialPoolOfferReplacement, PersistPoolOfferReplacement,
    },
    pool_offer::{
        MaterialPoolOfferConfirmation, PoolOffer, PoolOfferChange, PoolOfferReplacementDecision,
        PoolOfferReplacementStatus, Sha256Base64Url, SignedPoolOfferSet,
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
            false,
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

pub(super) async fn release_material(
    pool: &PgPool,
    replaced_session_id: &WorkSessionId,
    candidate_session_id: &WorkSessionId,
    now: u64,
) -> Result<crate::lifecycle::SessionReplacement, AuthorityPersistenceError> {
    let mut transaction = pool.begin().await?;
    let replacement = super::pool_selection::replace_work_session_in_transaction(
        &mut transaction,
        replaced_session_id,
        candidate_session_id,
        now,
        true,
    )
    .await?;
    sqlx::query(include_str!("queries/require_material_trusted_consent.sql"))
        .bind(candidate_session_id.as_str())
        .execute(&mut *transaction)
        .await?;
    transaction.commit().await?;
    Ok(replacement)
}

pub(super) async fn pending_material(
    pool: &PgPool,
    replaced_session_id: &WorkSessionId,
) -> Result<PendingMaterialPoolOfferReplacement, AuthorityPersistenceError> {
    let row = sqlx::query(include_str!(
        "queries/select_pending_material_pool_offer.sql"
    ))
    .bind(replaced_session_id.as_str())
    .fetch_optional(pool)
    .await?
    .ok_or(AuthorityPersistenceError::UnknownPoolOfferReplacement)?;
    Ok(PendingMaterialPoolOfferReplacement {
        challenge_id: crate::challenge::ChallengeId::try_from(
            row.try_get::<String, _>("challenge_id")?,
        )?,
        replaced_session_id: WorkSessionId::try_from(
            row.try_get::<String, _>("replaced_session_id")?,
        )?,
        candidate_session_id: WorkSessionId::try_from(
            row.try_get::<String, _>("candidate_session_id")?,
        )?,
        prior_offer: serde_json::from_value(row.try_get("prior_offer")?)
            .map_err(|_| AuthorityPersistenceError::InvalidPersistedData)?,
        candidate_offer: serde_json::from_value(row.try_get("candidate_offer")?)
            .map_err(|_| AuthorityPersistenceError::InvalidPersistedData)?,
        change: serde_json::from_value(row.try_get("change")?)
            .map_err(|_| AuthorityPersistenceError::InvalidPersistedData)?,
    })
}

pub(super) async fn persist_confirmation(
    pool: &PgPool,
    confirmation: &MaterialPoolOfferConfirmation,
) -> Result<MaterialPoolOfferConfirmation, AuthorityPersistenceError> {
    let signed = serde_json::to_value(confirmation.signed_pool_offers())
        .map_err(|_| AuthorityPersistenceError::InvalidPersistedData)?;
    let row = sqlx::query(include_str!(
        "queries/update_material_pool_offer_confirmation.sql"
    ))
    .bind(confirmation.replaced_session_id().as_str())
    .bind(signed)
    .bind(confirmation.disclosure_digest_sha256())
    .bind(confirmation.signature_digest_sha256().as_str())
    .fetch_optional(pool)
    .await?
    .ok_or(AuthorityPersistenceError::UnknownPoolOfferReplacement)?;
    let retained = confirmation_from_row(&row)?;
    if retained != *confirmation {
        return Err(AuthorityPersistenceError::ConflictingPoolOfferReplacement);
    }
    Ok(retained)
}

pub(super) async fn maybe_confirmation_by_binding(
    pool: &PgPool,
    challenge_id: &crate::challenge::ChallengeId,
    signature_digest_sha256: &Sha256Base64Url,
) -> Result<Option<MaterialPoolOfferConfirmation>, AuthorityPersistenceError> {
    sqlx::query(include_str!(
        "queries/select_material_confirmation_by_binding.sql"
    ))
    .bind(challenge_id.as_str())
    .bind(signature_digest_sha256.as_str())
    .fetch_optional(pool)
    .await?
    .map(|row| confirmation_from_row(&row))
    .transpose()
}

pub(super) async fn maybe_confirmation(
    pool: &PgPool,
    replaced_session_id: &WorkSessionId,
) -> Result<Option<MaterialPoolOfferConfirmation>, AuthorityPersistenceError> {
    sqlx::query(include_str!("queries/select_material_confirmation.sql"))
        .bind(replaced_session_id.as_str())
        .fetch_optional(pool)
        .await?
        .map(|row| confirmation_from_row(&row))
        .transpose()
}

fn confirmation_from_row(
    row: &PgRow,
) -> Result<MaterialPoolOfferConfirmation, AuthorityPersistenceError> {
    MaterialPoolOfferConfirmation::persisted(
        WorkSessionId::try_from(row.try_get::<String, _>("replaced_session_id")?)?,
        WorkSessionId::try_from(row.try_get::<String, _>("candidate_session_id")?)?,
        serde_json::from_value::<SignedPoolOfferSet>(row.try_get("required_signed_pool_offers")?)
            .map_err(|_| AuthorityPersistenceError::InvalidPersistedData)?,
        crate::pool_offer::Sha256Base64Url::try_from(
            row.try_get::<String, _>("disclosure_digest_sha256")?,
        )
        .map_err(|_| AuthorityPersistenceError::InvalidPersistedData)?,
    )
    .map_err(|_| AuthorityPersistenceError::InvalidPersistedData)
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
