use sqlx::{PgPool, Postgres, Row as _, Transaction, postgres::PgRow};

use super::unix_seconds_to_i64;
use crate::{
    authority_persistence::{AuthorityPersistenceError, PersistedSessionPoolSelection},
    challenge::ChallengeId,
    lifecycle::{
        ChallengeLifecycleCommand, ChallengeLifecycleState, SessionLifecycleState,
        SessionReplacement, SessionStopReason, apply_challenge_command,
    },
    pool_offer::{PoolOffer, PoolSelectionCommitment},
    progress::WorkSessionId,
};

pub(super) async fn session_pool_selection(
    pool: &PgPool,
    session_id: &WorkSessionId,
) -> Result<PersistedSessionPoolSelection, AuthorityPersistenceError> {
    let maybe_row = sqlx::query(include_str!("queries/select_session_pool_selection.sql"))
        .bind(session_id.as_str())
        .fetch_optional(pool)
        .await?;
    let Some(row) = maybe_row else {
        return Err(AuthorityPersistenceError::UnknownWorkSession);
    };
    let selection = persisted_selection(&row)?;
    let maybe_replacement_offer = row
        .try_get::<Option<serde_json::Value>, _>("replacement_offer")?
        .map(serde_json::from_value::<PoolOffer>)
        .transpose()
        .map_err(|_| AuthorityPersistenceError::InvalidPersistedData)?;
    if maybe_replacement_offer
        .as_ref()
        .is_some_and(|offer| offer.offer_id() != selection.pool_offer_id())
    {
        return Err(AuthorityPersistenceError::InvalidPersistedData);
    }
    Ok(PersistedSessionPoolSelection {
        challenge_id: ChallengeId::try_from(row.try_get::<String, _>("challenge_id")?)?,
        selection,
        maybe_replacement_offer,
    })
}

pub(super) async fn insert_work_session(
    pool: &PgPool,
    challenge_id: &ChallengeId,
    session_id: &WorkSessionId,
    now: u64,
) -> Result<(), AuthorityPersistenceError> {
    let mut transaction = pool.begin().await?;
    lock_work_session_identity(&mut transaction, session_id).await?;
    let maybe_row = sqlx::query_as::<_, (String, i64)>(
        "SELECT lifecycle_state, expires_at_unix_seconds
         FROM gate_authority.work_challenges
         WHERE challenge_id = $1 FOR UPDATE",
    )
    .bind(challenge_id.as_str())
    .fetch_optional(&mut *transaction)
    .await?;
    let Some((state, expires_at)) = maybe_row else {
        return Err(AuthorityPersistenceError::UnknownChallenge);
    };
    let state = ChallengeLifecycleState::parse(&state)?;
    apply_challenge_command(state, ChallengeLifecycleCommand::RegisterSession)
        .map_err(|_| AuthorityPersistenceError::ForbiddenLifecycleTransition)?;
    if unix_seconds_to_i64(now)? >= expires_at {
        return Err(AuthorityPersistenceError::ForbiddenLifecycleTransition);
    }
    let maybe_selection = sqlx::query_as::<_, (String, String)>(
        "SELECT pool_offer_id, payout_commitment
         FROM gate_authority.pool_selections
         WHERE challenge_id = $1 AND status = 'consented'",
    )
    .bind(challenge_id.as_str())
    .fetch_optional(&mut *transaction)
    .await?;
    let Some((pool_offer_id, payout_commitment)) = maybe_selection else {
        return Err(AuthorityPersistenceError::PoolSelectionRequired);
    };
    let result = sqlx::query(include_str!("queries/insert_work_session.sql"))
        .bind(session_id.as_str())
        .bind(challenge_id.as_str())
        .bind(pool_offer_id)
        .bind(payout_commitment)
        .execute(&mut *transaction)
        .await;
    match result {
        Ok(result) if result.rows_affected() == 1 => {
            transaction.commit().await?;
            Ok(())
        }
        Ok(_) => Err(AuthorityPersistenceError::TrustedConsentRequired),
        Err(error)
            if error
                .as_database_error()
                .is_some_and(|error| error.is_unique_violation()) =>
        {
            Err(AuthorityPersistenceError::DuplicateWorkSession)
        }
        Err(error) => Err(error.into()),
    }
}

pub(super) async fn replace_work_session(
    pool: &PgPool,
    replaced_session_id: &WorkSessionId,
    session_id: &WorkSessionId,
    now: u64,
) -> Result<SessionReplacement, AuthorityPersistenceError> {
    let mut transaction = pool.begin().await?;
    let replacement = replace_work_session_in_transaction(
        &mut transaction,
        replaced_session_id,
        session_id,
        now,
        false,
    )
    .await?;
    transaction.commit().await?;
    Ok(replacement)
}

pub(super) async fn replace_work_session_in_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    replaced_session_id: &WorkSessionId,
    session_id: &WorkSessionId,
    now: u64,
    allow_material_pending: bool,
) -> Result<SessionReplacement, AuthorityPersistenceError> {
    lock_work_session_identity(transaction, session_id).await?;
    let maybe_row = sqlx::query(include_str!("queries/lock_replaced_work_session.sql"))
        .bind(replaced_session_id.as_str())
        .fetch_optional(&mut **transaction)
        .await?;
    let Some(row) = maybe_row else {
        return Err(AuthorityPersistenceError::UnknownWorkSession);
    };
    let challenge_id = row.try_get::<String, _>("challenge_id")?;
    let maybe_pending_candidate = sqlx::query_scalar::<_, String>(include_str!(
        "queries/select_pending_replacement_candidate.sql"
    ))
    .bind(replaced_session_id.as_str())
    .fetch_optional(&mut **transaction)
    .await?;
    if maybe_pending_candidate.is_some() && !allow_material_pending {
        return Err(AuthorityPersistenceError::TrustedConsentRequired);
    }
    let maybe_reserved_predecessor = sqlx::query_scalar::<_, String>(include_str!(
        "queries/select_pending_replacement_predecessor_by_candidate.sql"
    ))
    .bind(session_id.as_str())
    .fetch_optional(&mut **transaction)
    .await?;
    if maybe_reserved_predecessor
        .as_deref()
        .is_some_and(|reserved| !allow_material_pending || reserved != replaced_session_id.as_str())
    {
        return Err(AuthorityPersistenceError::TrustedConsentRequired);
    }
    let maybe_existing = sqlx::query(include_str!(
        "queries/select_work_session_replacement_by_predecessor.sql"
    ))
    .bind(replaced_session_id.as_str())
    .fetch_optional(&mut **transaction)
    .await?;
    if let Some(existing) = maybe_existing {
        let replacement = replacement_from_row(&existing)?;
        if replacement.session_id() != session_id {
            return Err(AuthorityPersistenceError::ConflictingWorkSessionReplacement);
        }
        return Ok(replacement);
    }
    let session_state = SessionLifecycleState::parse(row.try_get("lifecycle_state")?)?;
    let reason = SessionStopReason::parse(row.try_get("stop_reason")?)?;
    if !matches!(
        session_state,
        SessionLifecycleState::Stopping | SessionLifecycleState::Failed
    ) || !reason.allows_replacement()
    {
        return Err(AuthorityPersistenceError::ForbiddenLifecycleTransition);
    }
    let challenge_state = ChallengeLifecycleState::parse(row.try_get("challenge_state")?)?;
    apply_challenge_command(challenge_state, ChallengeLifecycleCommand::RegisterSession)
        .map_err(|_| AuthorityPersistenceError::ForbiddenLifecycleTransition)?;
    if unix_seconds_to_i64(now)? >= row.try_get::<i64, _>("expires_at_unix_seconds")? {
        return Err(AuthorityPersistenceError::ForbiddenLifecycleTransition);
    }
    let next_generation = sqlx::query_scalar::<_, i64>(include_str!(
        "queries/next_work_session_replacement_generation.sql"
    ))
    .bind(&challenge_id)
    .fetch_one(&mut **transaction)
    .await?;
    let result = sqlx::query(include_str!("queries/insert_replacement_work_session.sql"))
        .bind(session_id.as_str())
        .bind(&challenge_id)
        .bind(row.try_get::<String, _>("pool_offer_id")?)
        .bind(row.try_get::<String, _>("payout_commitment")?)
        .bind(replaced_session_id.as_str())
        .bind(next_generation)
        .bind(reason.as_str())
        .execute(&mut **transaction)
        .await;
    match result {
        Ok(_) => Ok(SessionReplacement::persisted(
            session_id.clone(),
            replaced_session_id.clone(),
            u64::try_from(next_generation)
                .map_err(|_| AuthorityPersistenceError::InvalidPersistedData)?,
            reason,
        )?),
        Err(error)
            if error
                .as_database_error()
                .is_some_and(|error| error.is_unique_violation()) =>
        {
            Err(AuthorityPersistenceError::DuplicateWorkSession)
        }
        Err(error) => Err(error.into()),
    }
}

pub(super) async fn lock_work_session_identity(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: &WorkSessionId,
) -> Result<(), AuthorityPersistenceError> {
    sqlx::query(include_str!("queries/lock_work_session_identity.sql"))
        .bind(session_id.as_str())
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

pub(super) async fn maybe_session_replacement(
    pool: &PgPool,
    session_id: &WorkSessionId,
) -> Result<Option<SessionReplacement>, AuthorityPersistenceError> {
    let maybe_row = sqlx::query(include_str!("queries/select_work_session_replacement.sql"))
        .bind(session_id.as_str())
        .fetch_optional(pool)
        .await?;
    let Some(row) = maybe_row else {
        return Err(AuthorityPersistenceError::UnknownWorkSession);
    };
    let generation = row.try_get::<i64, _>("replacement_generation")?;
    if generation == 0 {
        if row
            .try_get::<Option<String>, _>("replaces_session_id")?
            .is_none()
            && row
                .try_get::<Option<String>, _>("replacement_reason")?
                .is_none()
        {
            return Ok(None);
        }
        return Err(AuthorityPersistenceError::InvalidPersistedData);
    }
    Ok(Some(replacement_from_row(&row)?))
}

fn replacement_from_row(row: &PgRow) -> Result<SessionReplacement, AuthorityPersistenceError> {
    Ok(SessionReplacement::persisted(
        WorkSessionId::try_from(row.try_get::<String, _>("session_id")?)?,
        WorkSessionId::try_from(row.try_get::<String, _>("replaces_session_id")?)?,
        u64::try_from(row.try_get::<i64, _>("replacement_generation")?)
            .map_err(|_| AuthorityPersistenceError::InvalidPersistedData)?,
        SessionStopReason::parse(row.try_get("replacement_reason")?)?,
    )?)
}

pub(super) async fn propose_pool_selection(
    pool: &PgPool,
    challenge_id: &ChallengeId,
    pool_offer_id: &str,
    payout_commitment: &str,
    now: u64,
) -> Result<PoolSelectionCommitment, AuthorityPersistenceError> {
    let mut transaction = pool.begin().await?;
    lock_selectable_challenge(
        &mut transaction,
        challenge_id,
        now,
        ChallengeLifecycleCommand::SelectPoolOffer,
    )
    .await?;
    let maybe_row = sqlx::query(
        "INSERT INTO gate_authority.pool_selections
           (challenge_id, pool_offer_id, payout_commitment, status, selected_at_unix_seconds)
         VALUES ($1, $2, $3, 'proposed', $4)
         ON CONFLICT (challenge_id) DO UPDATE
         SET pool_offer_id = EXCLUDED.pool_offer_id,
             payout_commitment = EXCLUDED.payout_commitment,
             selected_at_unix_seconds = EXCLUDED.selected_at_unix_seconds
         WHERE gate_authority.pool_selections.status = 'proposed'
         RETURNING pool_offer_id, payout_commitment",
    )
    .bind(challenge_id.as_str())
    .bind(pool_offer_id)
    .bind(payout_commitment)
    .bind(unix_seconds_to_i64(now)?)
    .fetch_optional(&mut *transaction)
    .await?;
    if let Some(row) = maybe_row {
        let selection = persisted_selection(&row)?;
        transaction.commit().await?;
        return Ok(selection);
    }
    let existing = sqlx::query(
        "SELECT pool_offer_id, payout_commitment
         FROM gate_authority.pool_selections WHERE challenge_id = $1",
    )
    .bind(challenge_id.as_str())
    .fetch_one(&mut *transaction)
    .await?;
    let selection = persisted_selection(&existing)?;
    if selection.pool_offer_id() != pool_offer_id || selection.commitment() != payout_commitment {
        return Err(AuthorityPersistenceError::PoolSelectionLocked);
    }
    transaction.commit().await?;
    Ok(selection)
}

pub(super) async fn confirm_pool_selection(
    pool: &PgPool,
    challenge_id: &ChallengeId,
    payout_commitment: &str,
    now: u64,
) -> Result<PoolSelectionCommitment, AuthorityPersistenceError> {
    let mut transaction = pool.begin().await?;
    lock_selectable_challenge(
        &mut transaction,
        challenge_id,
        now,
        ChallengeLifecycleCommand::ConfirmPoolSelection,
    )
    .await?;
    let maybe_row = sqlx::query(
        "SELECT pool_offer_id, payout_commitment, status
         FROM gate_authority.pool_selections WHERE challenge_id = $1 FOR UPDATE",
    )
    .bind(challenge_id.as_str())
    .fetch_optional(&mut *transaction)
    .await?;
    let Some(row) = maybe_row else {
        return Err(AuthorityPersistenceError::PoolSelectionRequired);
    };
    let selection = persisted_selection(&row)?;
    if selection.commitment() != payout_commitment {
        return Err(AuthorityPersistenceError::PoolSelectionMismatch);
    }
    let status = row.try_get::<String, _>("status")?;
    if status == "consented" {
        transaction.commit().await?;
        return Ok(selection);
    }
    if status != "proposed" {
        return Err(AuthorityPersistenceError::InvalidPersistedData);
    }
    sqlx::query(
        "UPDATE gate_authority.pool_selections
         SET status = 'consented', consented_at_unix_seconds = $2
         WHERE challenge_id = $1 AND status = 'proposed'",
    )
    .bind(challenge_id.as_str())
    .bind(unix_seconds_to_i64(now)?)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(selection)
}

async fn lock_selectable_challenge(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    challenge_id: &ChallengeId,
    now: u64,
    command: ChallengeLifecycleCommand,
) -> Result<(), AuthorityPersistenceError> {
    let maybe_row = sqlx::query_as::<_, (String, i64)>(
        "SELECT lifecycle_state, expires_at_unix_seconds
         FROM gate_authority.work_challenges WHERE challenge_id = $1 FOR UPDATE",
    )
    .bind(challenge_id.as_str())
    .fetch_optional(&mut **transaction)
    .await?;
    let Some((state, expires_at)) = maybe_row else {
        return Err(AuthorityPersistenceError::UnknownChallenge);
    };
    let state = ChallengeLifecycleState::parse(&state)?;
    apply_challenge_command(state, command)
        .map_err(|_| AuthorityPersistenceError::ForbiddenLifecycleTransition)?;
    if unix_seconds_to_i64(now)? >= expires_at {
        return Err(AuthorityPersistenceError::ForbiddenLifecycleTransition);
    }
    Ok(())
}

fn persisted_selection(
    row: &sqlx::postgres::PgRow,
) -> Result<PoolSelectionCommitment, AuthorityPersistenceError> {
    PoolSelectionCommitment::persisted(
        row.try_get("pool_offer_id")?,
        row.try_get("payout_commitment")?,
    )
    .map_err(|_| AuthorityPersistenceError::InvalidPersistedData)
}
