use sqlx::{PgPool, Postgres, Row as _, Transaction};

use crate::{
    authority_persistence::AuthorityPersistenceError,
    challenge::ChallengeId,
    lifecycle::{
        ChallengeLifecycle, ChallengeLifecycleCommand, ChallengeLifecycleState, LeaseObservation,
        LeaseObservationInput, PauseReason, SessionLifecycle, SessionLifecycleCommand,
        SessionLifecycleState, SessionStopReason, WorkLease, WorkerClock, WorkerInterruption,
        apply_challenge_command, apply_session_command, observe_work_lease,
    },
    progress::WorkSessionId,
};

pub(super) async fn challenge_lifecycle(
    pool: &PgPool,
    challenge_id: &ChallengeId,
    now: u64,
) -> Result<ChallengeLifecycle, AuthorityPersistenceError> {
    let mut transaction = pool.begin().await?;
    terminalize_expired(&mut transaction, challenge_id, now).await?;
    let lifecycle = select_challenge(&mut transaction, challenge_id).await?;
    transaction.commit().await?;
    Ok(lifecycle)
}

pub(super) async fn pause_challenge(
    pool: &PgPool,
    challenge_id: &ChallengeId,
    reason: PauseReason,
    now: u64,
) -> Result<ChallengeLifecycle, AuthorityPersistenceError> {
    let mut transaction = pool.begin().await?;
    terminalize_expired(&mut transaction, challenge_id, now).await?;
    let state = lock_challenge_state(&mut transaction, challenge_id).await?;
    if let Err(error) = apply_challenge_command(state, ChallengeLifecycleCommand::Pause) {
        transaction.commit().await?;
        return Err(transition_error(error));
    }
    stop_sessions(
        &mut transaction,
        challenge_id,
        reason.stop_reason(),
        &[SessionLifecycleState::Leased],
    )
    .await?;
    let lifecycle = select_challenge(&mut transaction, challenge_id).await?;
    transaction.commit().await?;
    Ok(lifecycle)
}

pub(super) async fn cancel_challenge(
    pool: &PgPool,
    challenge_id: &ChallengeId,
    now: u64,
) -> Result<ChallengeLifecycle, AuthorityPersistenceError> {
    let mut transaction = pool.begin().await?;
    terminalize_expired(&mut transaction, challenge_id, now).await?;
    let state = lock_challenge_state(&mut transaction, challenge_id).await?;
    let target = match apply_challenge_command(state, ChallengeLifecycleCommand::Cancel) {
        Ok(target) => target,
        Err(error) => {
            transaction.commit().await?;
            return Err(transition_error(error));
        }
    };
    if target == state {
        let lifecycle = select_challenge(&mut transaction, challenge_id).await?;
        transaction.commit().await?;
        return Ok(lifecycle);
    }
    sqlx::query(
        "UPDATE gate_authority.work_challenges
         SET lifecycle_state = 'cancelled',
             lifecycle_changed_at_unix_seconds = $2,
             terminal_at_unix_seconds = $2
         WHERE challenge_id = $1",
    )
    .bind(challenge_id.as_str())
    .bind(to_i64(now)?)
    .execute(&mut *transaction)
    .await?;
    stop_sessions(
        &mut transaction,
        challenge_id,
        SessionStopReason::ChallengeCancelled,
        &[SessionLifecycleState::Ready, SessionLifecycleState::Leased],
    )
    .await?;
    let lifecycle = select_challenge(&mut transaction, challenge_id).await?;
    transaction.commit().await?;
    Ok(lifecycle)
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn start_work_lease(
    pool: &PgPool,
    session_id: &WorkSessionId,
    clock: &WorkerClock,
    lease_id: &str,
    renew_at_monotonic_milliseconds: u64,
    expires_at_monotonic_milliseconds: u64,
    now: u64,
) -> Result<WorkLease, AuthorityPersistenceError> {
    let mut transaction = pool.begin().await?;
    let challenge_id = challenge_id_for_session(&mut transaction, session_id).await?;
    terminalize_expired(&mut transaction, &challenge_id, now).await?;
    let (challenge_state, session_state, selection_consented) =
        lock_challenge_and_session(&mut transaction, session_id).await?;
    if !selection_consented {
        transaction.commit().await?;
        return Err(AuthorityPersistenceError::PoolSelectionRequired);
    }
    let target_challenge =
        apply_challenge_command(challenge_state, ChallengeLifecycleCommand::StartWork);
    let target_session = apply_session_command(session_state, SessionLifecycleCommand::StartLease);
    let (Ok(target_challenge), Ok(_)) = (target_challenge, target_session) else {
        transaction.commit().await?;
        return Err(AuthorityPersistenceError::ForbiddenLifecycleTransition);
    };
    if target_challenge != challenge_state {
        sqlx::query(
            "UPDATE gate_authority.work_challenges
             SET lifecycle_state = 'active', lifecycle_changed_at_unix_seconds = $2
             WHERE challenge_id = $1",
        )
        .bind(challenge_id.as_str())
        .bind(to_i64(now)?)
        .execute(&mut *transaction)
        .await?;
    }
    sqlx::query(
        "UPDATE gate_authority.work_sessions
         SET lifecycle_state = 'leased', lease_id = $2::uuid, continuity_id = $3,
             last_monotonic_milliseconds = $4, renew_at_monotonic_milliseconds = $5,
             expires_at_monotonic_milliseconds = $6, stop_reason = NULL
         WHERE session_id = $1",
    )
    .bind(session_id.as_str())
    .bind(lease_id)
    .bind(clock.continuity_id())
    .bind(to_i64(clock.monotonic_milliseconds())?)
    .bind(to_i64(renew_at_monotonic_milliseconds)?)
    .bind(to_i64(expires_at_monotonic_milliseconds)?)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(WorkLease::persisted(
        lease_id.to_owned(),
        renew_at_monotonic_milliseconds,
        expires_at_monotonic_milliseconds,
    ))
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn renew_work_lease(
    pool: &PgPool,
    session_id: &WorkSessionId,
    lease_id: &str,
    clock: &WorkerClock,
    renew_at_monotonic_milliseconds: u64,
    expires_at_monotonic_milliseconds: u64,
    now: u64,
) -> Result<WorkLease, AuthorityPersistenceError> {
    let mut transaction = pool.begin().await?;
    let challenge_id = challenge_id_for_session(&mut transaction, session_id).await?;
    terminalize_expired(&mut transaction, &challenge_id, now).await?;
    let row = sqlx::query(
        "SELECT lifecycle_state, lease_id::text AS lease_id, continuity_id,
                last_monotonic_milliseconds, expires_at_monotonic_milliseconds
         FROM gate_authority.work_sessions WHERE session_id = $1 FOR UPDATE",
    )
    .bind(session_id.as_str())
    .fetch_one(&mut *transaction)
    .await?;
    let state = SessionLifecycleState::parse(row.try_get("lifecycle_state")?)?;
    if let Err(error) = apply_session_command(state, SessionLifecycleCommand::ObserveLease) {
        transaction.commit().await?;
        return Err(transition_error(error));
    }
    let persisted_lease_id = row.try_get::<String, _>("lease_id")?;
    let continuity_id = row.try_get::<String, _>("continuity_id")?;
    let last_monotonic = to_u64(row.try_get("last_monotonic_milliseconds")?)?;
    let current_expiry = to_u64(row.try_get("expires_at_monotonic_milliseconds")?)?;
    let observation = observe_work_lease(LeaseObservationInput {
        state,
        expected_lease_id: &persisted_lease_id,
        expected_continuity_id: &continuity_id,
        last_monotonic_milliseconds: last_monotonic,
        expires_at_monotonic_milliseconds: current_expiry,
        presented_lease_id: lease_id,
        clock,
    })
    .map_err(lease_observation_error)?;
    if let LeaseObservation::Stop(reason) = observation {
        stop_one_session(&mut transaction, session_id, reason).await?;
        transaction.commit().await?;
        return Err(stopped_lease_error(reason));
    }
    sqlx::query(
        "UPDATE gate_authority.work_sessions
         SET last_monotonic_milliseconds = $2, renew_at_monotonic_milliseconds = $3,
             expires_at_monotonic_milliseconds = $4
         WHERE session_id = $1",
    )
    .bind(session_id.as_str())
    .bind(to_i64(clock.monotonic_milliseconds())?)
    .bind(to_i64(renew_at_monotonic_milliseconds)?)
    .bind(to_i64(expires_at_monotonic_milliseconds)?)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(WorkLease::persisted(
        lease_id.to_owned(),
        renew_at_monotonic_milliseconds,
        expires_at_monotonic_milliseconds,
    ))
}

pub(super) async fn interrupt_work_session(
    pool: &PgPool,
    session_id: &WorkSessionId,
    interruption: WorkerInterruption,
) -> Result<(), AuthorityPersistenceError> {
    let mut transaction = pool.begin().await?;
    let state = lock_session_state(&mut transaction, session_id).await?;
    let target =
        apply_session_command(state, SessionLifecycleCommand::Stop).map_err(transition_error)?;
    if target == state {
        transaction.commit().await?;
        return Ok(());
    }
    stop_one_session(&mut transaction, session_id, interruption.stop_reason()).await?;
    transaction.commit().await?;
    Ok(())
}

pub(super) async fn confirm_work_session_restored(
    pool: &PgPool,
    session_id: &WorkSessionId,
) -> Result<(), AuthorityPersistenceError> {
    let mut transaction = pool.begin().await?;
    let state = lock_session_state(&mut transaction, session_id).await?;
    let target = apply_session_command(state, SessionLifecycleCommand::ConfirmRestored)
        .map_err(transition_error)?;
    if target == state {
        transaction.commit().await?;
        return Ok(());
    }
    sqlx::query(
        "UPDATE gate_authority.work_sessions SET lifecycle_state = 'restored'
         WHERE session_id = $1",
    )
    .bind(session_id.as_str())
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(())
}

pub(super) async fn fail_work_session(
    pool: &PgPool,
    session_id: &WorkSessionId,
) -> Result<(), AuthorityPersistenceError> {
    let mut transaction = pool.begin().await?;
    let state = lock_session_state(&mut transaction, session_id).await?;
    let target =
        apply_session_command(state, SessionLifecycleCommand::Fail).map_err(transition_error)?;
    if target == state {
        transaction.commit().await?;
        return Ok(());
    }
    sqlx::query(
        "UPDATE gate_authority.work_sessions
         SET lifecycle_state = 'failed', lease_id = NULL, continuity_id = NULL,
             last_monotonic_milliseconds = NULL, renew_at_monotonic_milliseconds = NULL,
             expires_at_monotonic_milliseconds = NULL, stop_reason = 'session_failed'
         WHERE session_id = $1",
    )
    .bind(session_id.as_str())
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(())
}

pub(super) async fn work_session_lifecycle(
    pool: &PgPool,
    session_id: &WorkSessionId,
) -> Result<SessionLifecycle, AuthorityPersistenceError> {
    let maybe_row = sqlx::query(
        "SELECT session_id, challenge_id, lifecycle_state, stop_reason,
                lease_id::text AS lease_id, renew_at_monotonic_milliseconds,
                expires_at_monotonic_milliseconds
         FROM gate_authority.work_sessions WHERE session_id = $1",
    )
    .bind(session_id.as_str())
    .fetch_optional(pool)
    .await?;
    let Some(row) = maybe_row else {
        return Err(AuthorityPersistenceError::UnknownWorkSession);
    };
    let state = SessionLifecycleState::parse(row.try_get("lifecycle_state")?)?;
    let maybe_lease_id = row.try_get::<Option<String>, _>("lease_id")?;
    let maybe_lease = match maybe_lease_id {
        Some(lease_id) => Some(WorkLease::persisted(
            lease_id,
            to_u64(row.try_get("renew_at_monotonic_milliseconds")?)?,
            to_u64(row.try_get("expires_at_monotonic_milliseconds")?)?,
        )),
        None => None,
    };
    Ok(SessionLifecycle::persisted(
        WorkSessionId::try_from(row.try_get::<String, _>("session_id")?)?,
        ChallengeId::try_from(row.try_get::<String, _>("challenge_id")?)?,
        state,
        row.try_get("stop_reason")?,
        maybe_lease,
    )?)
}

async fn terminalize_expired(
    transaction: &mut Transaction<'_, Postgres>,
    challenge_id: &ChallengeId,
    now: u64,
) -> Result<(), AuthorityPersistenceError> {
    let maybe_row = sqlx::query(
        "SELECT challenge.lifecycle_state, challenge.expires_at_unix_seconds,
                intent.expires_at_unix_seconds AS pass_expires_at_unix_seconds
         FROM gate_authority.work_challenges AS challenge
         LEFT JOIN gate_authority.gate_pass_issuance_intents AS intent
           ON intent.challenge_id = challenge.challenge_id
         WHERE challenge.challenge_id = $1
         FOR UPDATE OF challenge",
    )
    .bind(challenge_id.as_str())
    .fetch_optional(&mut **transaction)
    .await?;
    let Some(row) = maybe_row else {
        return Err(AuthorityPersistenceError::UnknownChallenge);
    };
    let state = ChallengeLifecycleState::parse(row.try_get("lifecycle_state")?)?;
    let deadline = if state == ChallengeLifecycleState::PassIssued {
        to_u64(
            row.try_get::<Option<i64>, _>("pass_expires_at_unix_seconds")?
                .ok_or(AuthorityPersistenceError::InvalidPersistedData)?,
        )?
    } else {
        to_u64(row.try_get("expires_at_unix_seconds")?)?
    };
    if now < deadline {
        return Ok(());
    }
    let target = match apply_challenge_command(state, ChallengeLifecycleCommand::Expire) {
        Ok(target) => target,
        Err(crate::lifecycle::LifecycleError::ForbiddenTransition) => return Ok(()),
        Err(error) => return Err(AuthorityPersistenceError::InvalidLifecycle(error)),
    };
    if target == state {
        return Ok(());
    }
    sqlx::query(
        "UPDATE gate_authority.work_challenges
         SET lifecycle_state = 'expired', lifecycle_changed_at_unix_seconds = $2,
             terminal_at_unix_seconds = COALESCE(terminal_at_unix_seconds, $2)
         WHERE challenge_id = $1",
    )
    .bind(challenge_id.as_str())
    .bind(to_i64(deadline)?)
    .execute(&mut **transaction)
    .await?;
    stop_sessions(
        transaction,
        challenge_id,
        SessionStopReason::ChallengeExpired,
        &[SessionLifecycleState::Ready, SessionLifecycleState::Leased],
    )
    .await?;
    Ok(())
}

async fn select_challenge(
    transaction: &mut Transaction<'_, Postgres>,
    challenge_id: &ChallengeId,
) -> Result<ChallengeLifecycle, AuthorityPersistenceError> {
    let maybe_row = sqlx::query(
        "SELECT challenge.challenge_id, challenge.lifecycle_state,
                challenge.verified_progress::text AS verified_progress,
                challenge.work_requirement::text AS work_requirement,
                challenge.expires_at_unix_seconds,
                CASE
                    WHEN challenge.lifecycle_state = 'pass_issued'
                    THEN intent.expires_at_unix_seconds
                    ELSE challenge.expires_at_unix_seconds
                END AS lifecycle_deadline_unix_seconds
         FROM gate_authority.work_challenges AS challenge
         LEFT JOIN gate_authority.gate_pass_issuance_intents AS intent
           ON intent.challenge_id = challenge.challenge_id
         WHERE challenge.challenge_id = $1",
    )
    .bind(challenge_id.as_str())
    .fetch_optional(&mut **transaction)
    .await?;
    let Some(row) = maybe_row else {
        return Err(AuthorityPersistenceError::UnknownChallenge);
    };
    let state = ChallengeLifecycleState::parse(row.try_get("lifecycle_state")?)?;
    Ok(ChallengeLifecycle::persisted(
        ChallengeId::try_from(row.try_get::<String, _>("challenge_id")?)?,
        state,
        row.try_get("verified_progress")?,
        row.try_get("work_requirement")?,
        to_u64(row.try_get("expires_at_unix_seconds")?)?,
        to_u64(row.try_get("lifecycle_deadline_unix_seconds")?)?,
    ))
}

async fn lock_challenge_state(
    transaction: &mut Transaction<'_, Postgres>,
    challenge_id: &ChallengeId,
) -> Result<ChallengeLifecycleState, AuthorityPersistenceError> {
    let maybe_state = sqlx::query_scalar::<_, String>(
        "SELECT lifecycle_state FROM gate_authority.work_challenges
         WHERE challenge_id = $1 FOR UPDATE",
    )
    .bind(challenge_id.as_str())
    .fetch_optional(&mut **transaction)
    .await?;
    let Some(state) = maybe_state else {
        return Err(AuthorityPersistenceError::UnknownChallenge);
    };
    Ok(ChallengeLifecycleState::parse(&state)?)
}

async fn challenge_id_for_session(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: &WorkSessionId,
) -> Result<ChallengeId, AuthorityPersistenceError> {
    let maybe_challenge_id = sqlx::query_scalar::<_, String>(
        "SELECT challenge_id FROM gate_authority.work_sessions WHERE session_id = $1",
    )
    .bind(session_id.as_str())
    .fetch_optional(&mut **transaction)
    .await?;
    let Some(challenge_id) = maybe_challenge_id else {
        return Err(AuthorityPersistenceError::UnknownWorkSession);
    };
    Ok(ChallengeId::try_from(challenge_id)?)
}

async fn lock_challenge_and_session(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: &WorkSessionId,
) -> Result<(ChallengeLifecycleState, SessionLifecycleState, bool), AuthorityPersistenceError> {
    let maybe_row = sqlx::query(
        "SELECT challenge.lifecycle_state AS challenge_state,
                session.lifecycle_state AS session_state,
                selection.status = 'consented' AS selection_consented
         FROM gate_authority.work_sessions AS session
         JOIN gate_authority.work_challenges AS challenge
           ON challenge.challenge_id = session.challenge_id
         LEFT JOIN gate_authority.pool_selections AS selection
           ON selection.challenge_id = session.challenge_id
          AND selection.pool_offer_id = session.pool_offer_id
          AND selection.payout_commitment = session.payout_commitment
         WHERE session.session_id = $1
         FOR UPDATE OF challenge, session",
    )
    .bind(session_id.as_str())
    .fetch_optional(&mut **transaction)
    .await?;
    let Some(row) = maybe_row else {
        return Err(AuthorityPersistenceError::UnknownWorkSession);
    };
    Ok((
        ChallengeLifecycleState::parse(row.try_get("challenge_state")?)?,
        SessionLifecycleState::parse(row.try_get("session_state")?)?,
        row.try_get::<Option<bool>, _>("selection_consented")?
            .unwrap_or(false),
    ))
}

async fn lock_session_state(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: &WorkSessionId,
) -> Result<SessionLifecycleState, AuthorityPersistenceError> {
    let maybe_state = sqlx::query_scalar::<_, String>(
        "SELECT lifecycle_state FROM gate_authority.work_sessions
         WHERE session_id = $1 FOR UPDATE",
    )
    .bind(session_id.as_str())
    .fetch_optional(&mut **transaction)
    .await?;
    let Some(state) = maybe_state else {
        return Err(AuthorityPersistenceError::UnknownWorkSession);
    };
    Ok(SessionLifecycleState::parse(&state)?)
}

async fn stop_sessions(
    transaction: &mut Transaction<'_, Postgres>,
    challenge_id: &ChallengeId,
    reason: SessionStopReason,
    from_states: &[SessionLifecycleState],
) -> Result<(), AuthorityPersistenceError> {
    let states = from_states
        .iter()
        .map(|state| state.as_str())
        .collect::<Vec<_>>();
    sqlx::query(
        "UPDATE gate_authority.work_sessions
         SET lifecycle_state = 'stopping', lease_id = NULL, continuity_id = NULL,
             last_monotonic_milliseconds = NULL, renew_at_monotonic_milliseconds = NULL,
             expires_at_monotonic_milliseconds = NULL, stop_reason = $2
         WHERE challenge_id = $1 AND lifecycle_state = ANY($3)",
    )
    .bind(challenge_id.as_str())
    .bind(reason.as_str())
    .bind(states)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn stop_one_session(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: &WorkSessionId,
    reason: SessionStopReason,
) -> Result<(), AuthorityPersistenceError> {
    sqlx::query(
        "UPDATE gate_authority.work_sessions
         SET lifecycle_state = 'stopping', lease_id = NULL, continuity_id = NULL,
             last_monotonic_milliseconds = NULL, renew_at_monotonic_milliseconds = NULL,
             expires_at_monotonic_milliseconds = NULL, stop_reason = $2
         WHERE session_id = $1",
    )
    .bind(session_id.as_str())
    .bind(reason.as_str())
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

fn to_i64(value: u64) -> Result<i64, AuthorityPersistenceError> {
    i64::try_from(value).map_err(|_| AuthorityPersistenceError::InvalidPersistedData)
}

fn to_u64(value: i64) -> Result<u64, AuthorityPersistenceError> {
    u64::try_from(value).map_err(|_| AuthorityPersistenceError::InvalidPersistedData)
}

fn transition_error(error: crate::lifecycle::LifecycleError) -> AuthorityPersistenceError {
    if error == crate::lifecycle::LifecycleError::ForbiddenTransition {
        return AuthorityPersistenceError::ForbiddenLifecycleTransition;
    }
    AuthorityPersistenceError::InvalidLifecycle(error)
}

fn lease_observation_error(error: crate::lifecycle::LifecycleError) -> AuthorityPersistenceError {
    match error {
        crate::lifecycle::LifecycleError::ForbiddenTransition => {
            AuthorityPersistenceError::ForbiddenLifecycleTransition
        }
        crate::lifecycle::LifecycleError::WrongWorkLease => {
            AuthorityPersistenceError::WrongWorkLease
        }
        error => AuthorityPersistenceError::InvalidLifecycle(error),
    }
}

fn stopped_lease_error(reason: SessionStopReason) -> AuthorityPersistenceError {
    match reason {
        SessionStopReason::LeaseExpired => AuthorityPersistenceError::WorkLeaseExpired,
        SessionStopReason::WorkerReboot | SessionStopReason::MonotonicReset => {
            AuthorityPersistenceError::WorkerContinuityLost
        }
        _ => AuthorityPersistenceError::InvalidPersistedData,
    }
}
