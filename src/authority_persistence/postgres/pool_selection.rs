use sqlx::{PgPool, Row as _};

use super::unix_seconds_to_i64;
use crate::{
    authority_persistence::{AuthorityPersistenceError, PersistedSessionPoolSelection},
    challenge::ChallengeId,
    lifecycle::{ChallengeLifecycleCommand, ChallengeLifecycleState, apply_challenge_command},
    pool_offer::PoolSelectionCommitment,
    progress::WorkSessionId,
};

pub(super) async fn session_pool_selection(
    pool: &PgPool,
    session_id: &WorkSessionId,
) -> Result<PersistedSessionPoolSelection, AuthorityPersistenceError> {
    let maybe_row = sqlx::query(
        "SELECT challenge_id, pool_offer_id, payout_commitment
         FROM gate_authority.work_sessions WHERE session_id = $1",
    )
    .bind(session_id.as_str())
    .fetch_optional(pool)
    .await?;
    let Some(row) = maybe_row else {
        return Err(AuthorityPersistenceError::UnknownWorkSession);
    };
    Ok(PersistedSessionPoolSelection {
        challenge_id: ChallengeId::try_from(row.try_get::<String, _>("challenge_id")?)?,
        selection: persisted_selection(&row)?,
    })
}

pub(super) async fn insert_work_session(
    pool: &PgPool,
    challenge_id: &ChallengeId,
    session_id: &WorkSessionId,
    now: u64,
) -> Result<(), AuthorityPersistenceError> {
    let mut transaction = pool.begin().await?;
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
        Ok(_) => {
            transaction.commit().await?;
            Ok(())
        }
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
