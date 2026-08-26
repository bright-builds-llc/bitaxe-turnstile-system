use sqlx::{Row as _, postgres::PgRow};
use uuid::Uuid;

use super::unix_seconds_to_i64;
use crate::{
    authority_persistence::{AuthorityPersistenceError, PersistedAcceptance, PersistedIssuance},
    challenge::{ChallengeId, WorkChallengeDescriptor},
    crypto_profile::{GATE_PASS_JWS_ALGORITHM, GatePassClaimsSeed},
    lifecycle::{
        LeaseObservation, LeaseObservationInput, SessionLifecycleCommand, SessionLifecycleState,
        WorkerClock, apply_session_command, observe_work_lease,
    },
    progress::{
        AcceptedWorkAcknowledgement, AcceptedWorkDisposition, AcceptedWorkEvent,
        AcceptedWorkEventId, NetworkTargetOutcome, PersistedAcknowledgementInput, ReceiptTime,
        WorkSessionId,
    },
    work::{CreditedWork, VerifiedProgress},
};

pub(super) async fn challenge_for_session(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    event: &AcceptedWorkEvent,
) -> Result<String, AuthorityPersistenceError> {
    let maybe_challenge_id = sqlx::query_scalar::<_, String>(
        "SELECT challenge_id FROM gate_authority.work_sessions WHERE session_id = $1",
    )
    .bind(event.work_session_id().as_str())
    .fetch_optional(&mut **transaction)
    .await?;
    let Some(challenge_id) = maybe_challenge_id else {
        return Err(AuthorityPersistenceError::UnknownWorkSession);
    };
    Ok(challenge_id)
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn complete_issuance(
    pool: &sqlx::PgPool,
    worker_id: &str,
    challenge_id: &ChallengeId,
    authority_kid: &str,
    gate_pass: &str,
    issued_at: u64,
    expires_at: u64,
) -> Result<(), AuthorityPersistenceError> {
    let mut transaction = pool.begin().await?;
    let result = sqlx::query(include_str!("queries/complete_issuance.sql"))
        .bind(challenge_id.as_str())
        .bind(worker_id)
        .bind(authority_kid)
        .bind(gate_pass)
        .bind(unix_seconds_to_i64(issued_at)?)
        .bind(unix_seconds_to_i64(expires_at)?)
        .execute(&mut *transaction)
        .await?;
    if result.rows_affected() != 1 {
        return Err(AuthorityPersistenceError::LostSigningLease);
    }
    sqlx::query(include_str!("queries/mark_challenge_issued.sql"))
        .bind(challenge_id.as_str())
        .bind(unix_seconds_to_i64(issued_at)?)
        .execute(&mut *transaction)
        .await?;
    sqlx::query(include_str!("queries/mark_outbox_completed.sql"))
        .bind(challenge_id.as_str())
        .execute(&mut *transaction)
        .await?;
    transaction.commit().await?;
    Ok(())
}

pub(super) async fn issuance(
    pool: &sqlx::PgPool,
    challenge_id: &ChallengeId,
) -> Result<PersistedIssuance, AuthorityPersistenceError> {
    let maybe_row = sqlx::query_as::<_, (Option<String>, Option<String>, Option<i64>)>(
        include_str!("queries/select_issuance.sql"),
    )
    .bind(challenge_id.as_str())
    .fetch_optional(pool)
    .await?;
    let Some((maybe_status, maybe_gate_pass, maybe_retired_at)) = maybe_row else {
        return Err(AuthorityPersistenceError::UnknownChallenge);
    };
    match (maybe_status.as_deref(), maybe_gate_pass, maybe_retired_at) {
        (None | Some("pending" | "signing"), None, None) => Ok(PersistedIssuance::Pending),
        (Some("issued"), Some(gate_pass), None) => Ok(PersistedIssuance::Issued { gate_pass }),
        (Some("issued"), None, Some(_)) => Ok(PersistedIssuance::Retired),
        (Some("failed"), None, None) => Ok(PersistedIssuance::Failed),
        _ => Err(AuthorityPersistenceError::InvalidPersistedData),
    }
}

pub(super) async fn challenge(
    pool: &sqlx::PgPool,
    challenge_id: &ChallengeId,
) -> Result<WorkChallengeDescriptor, AuthorityPersistenceError> {
    let maybe_descriptor = sqlx::query_scalar::<_, serde_json::Value>(
        "SELECT descriptor FROM gate_authority.work_challenges WHERE challenge_id = $1",
    )
    .bind(challenge_id.as_str())
    .fetch_optional(pool)
    .await?;
    let Some(descriptor) = maybe_descriptor else {
        return Err(AuthorityPersistenceError::UnknownChallenge);
    };
    serde_json::from_value(descriptor).map_err(|_| AuthorityPersistenceError::InvalidPersistedData)
}

pub(super) async fn consume_issuance_proof(
    pool: &sqlx::PgPool,
    challenge_id: &ChallengeId,
    proof_id: &str,
    expires_at: u64,
    now: u64,
) -> Result<(), AuthorityPersistenceError> {
    let mut transaction = pool.begin().await?;
    sqlx::query(
        "DELETE FROM gate_authority.claimant_issuance_proofs WHERE expires_at_unix_seconds < $1",
    )
    .bind(unix_seconds_to_i64(now)?)
    .execute(&mut *transaction)
    .await?;
    let result = sqlx::query(include_str!("queries/insert_claimant_proof.sql"))
        .bind(proof_id)
        .bind(challenge_id.as_str())
        .bind(unix_seconds_to_i64(expires_at)?)
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
            Err(AuthorityPersistenceError::ReplayedIssuanceProof)
        }
        Err(error) => Err(error.into()),
    }
}

pub(super) async fn observe_session_lease(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    event: &AcceptedWorkEvent,
    challenge_id: &str,
    lease_id: &str,
    clock: &WorkerClock,
) -> Result<LeaseObservation, AuthorityPersistenceError> {
    let maybe_row = sqlx::query(
        "SELECT challenge_id, lifecycle_state, lease_id::text AS lease_id, continuity_id,
                last_monotonic_milliseconds, expires_at_monotonic_milliseconds
         FROM gate_authority.work_sessions WHERE session_id = $1 FOR UPDATE",
    )
    .bind(event.work_session_id().as_str())
    .fetch_optional(&mut **transaction)
    .await?;
    let Some(row) = maybe_row else {
        return Err(AuthorityPersistenceError::UnknownWorkSession);
    };
    let persisted_challenge_id = row.try_get::<String, _>("challenge_id")?;
    let state = SessionLifecycleState::parse(row.try_get("lifecycle_state")?)?;
    if persisted_challenge_id != challenge_id {
        return Err(AuthorityPersistenceError::ForbiddenLifecycleTransition);
    }
    apply_session_command(state, SessionLifecycleCommand::ObserveLease).map_err(map_lease_error)?;
    let persisted_lease_id = row.try_get::<String, _>("lease_id")?;
    let continuity_id = row.try_get::<String, _>("continuity_id")?;
    let last_monotonic_milliseconds = to_u64(row.try_get("last_monotonic_milliseconds")?)?;
    let expires_at_monotonic_milliseconds =
        to_u64(row.try_get("expires_at_monotonic_milliseconds")?)?;
    let observation = observe_work_lease(LeaseObservationInput {
        state,
        expected_lease_id: &persisted_lease_id,
        expected_continuity_id: &continuity_id,
        last_monotonic_milliseconds,
        expires_at_monotonic_milliseconds,
        presented_lease_id: lease_id,
        clock,
    })
    .map_err(map_lease_error)?;
    match observation {
        LeaseObservation::Accepted => {
            sqlx::query(
                "UPDATE gate_authority.work_sessions
                 SET last_monotonic_milliseconds = $2 WHERE session_id = $1",
            )
            .bind(event.work_session_id().as_str())
            .bind(to_i64(clock.monotonic_milliseconds())?)
            .execute(&mut **transaction)
            .await?;
        }
        LeaseObservation::Stop(reason) => {
            sqlx::query(
                "UPDATE gate_authority.work_sessions
                 SET lifecycle_state = 'stopping', lease_id = NULL, continuity_id = NULL,
                     last_monotonic_milliseconds = NULL,
                     renew_at_monotonic_milliseconds = NULL,
                     expires_at_monotonic_milliseconds = NULL, stop_reason = $2
                 WHERE session_id = $1",
            )
            .bind(event.work_session_id().as_str())
            .bind(reason.as_str())
            .execute(&mut **transaction)
            .await?;
        }
    }
    Ok(observation)
}

fn map_lease_error(error: crate::lifecycle::LifecycleError) -> AuthorityPersistenceError {
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

fn to_i64(value: u64) -> Result<i64, AuthorityPersistenceError> {
    i64::try_from(value).map_err(|_| AuthorityPersistenceError::InvalidPersistedData)
}

fn to_u64(value: i64) -> Result<u64, AuthorityPersistenceError> {
    u64::try_from(value).map_err(|_| AuthorityPersistenceError::InvalidPersistedData)
}

pub(super) async fn insert_share_fingerprint(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    share_fingerprint: &str,
    challenge_id: &str,
) -> Result<bool, AuthorityPersistenceError> {
    let result = sqlx::query(include_str!("queries/insert_share_fingerprint.sql"))
        .bind(share_fingerprint)
        .bind(challenge_id)
        .execute(&mut **transaction)
        .await?;
    Ok(result.rows_affected() == 1)
}

pub(super) async fn update_progress(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    challenge_id: &str,
    verified_progress: VerifiedProgress,
    satisfied: bool,
    changed_at: u64,
) -> Result<(), AuthorityPersistenceError> {
    sqlx::query(include_str!("queries/update_progress.sql"))
        .bind(challenge_id)
        .bind(verified_progress.to_decimal_string())
        .bind(satisfied)
        .bind(unix_seconds_to_i64(changed_at)?)
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

pub(super) async fn insert_issuance_intent(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    challenge_id: &str,
    signing_deadline: i64,
    available_at: u64,
    claims_seed: GatePassClaimsSeed,
) -> Result<(), AuthorityPersistenceError> {
    let pass_id = format!("pass_{}", Uuid::new_v4().simple());
    let claims_template = serde_json::to_value(claims_seed.with_pass_id(pass_id.clone()))
        .map_err(|_| AuthorityPersistenceError::InvalidPersistedData)?;
    sqlx::query(include_str!("queries/insert_issuance_intent.sql"))
        .bind(challenge_id)
        .bind(pass_id)
        .bind(GATE_PASS_JWS_ALGORITHM)
        .bind(claims_template)
        .bind(signing_deadline)
        .execute(&mut **transaction)
        .await?;
    sqlx::query(include_str!("queries/insert_outbox.sql"))
        .bind(Uuid::new_v4())
        .bind(challenge_id)
        .bind(unix_seconds_to_i64(available_at)?)
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

pub(super) struct AcceptedEventRecordInput<'a> {
    pub challenge_id: &'a str,
    pub event: &'a AcceptedWorkEvent,
    pub disposition: AcceptedWorkDisposition,
    pub maybe_credited_work: Option<CreditedWork>,
    pub verified_progress: VerifiedProgress,
    pub work_requirement: CreditedWork,
    pub issuance_intent_created: bool,
}

pub(super) async fn insert_accepted_event(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    input: AcceptedEventRecordInput<'_>,
) -> Result<(), AuthorityPersistenceError> {
    let received_at = unix_seconds_to_i64(input.event.received_at().unix_seconds())?;
    sqlx::query(include_str!("queries/insert_accepted_event.sql"))
        .bind(input.event.event_id().as_str())
        .bind(input.challenge_id)
        .bind(input.event.work_session_id().as_str())
        .bind(input.event.assigned_target().to_be_bytes().to_vec())
        .bind(received_at)
        .bind(input.event.share_fingerprint().as_str())
        .bind(input.event.network_target_outcome().as_str())
        .bind(input.disposition.as_str())
        .bind(
            input
                .maybe_credited_work
                .map(CreditedWork::to_decimal_string),
        )
        .bind(input.verified_progress.to_decimal_string())
        .bind(input.work_requirement.to_decimal_string())
        .bind(input.issuance_intent_created)
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

pub(super) fn persisted_acceptance(
    row: &PgRow,
    event: &AcceptedWorkEvent,
) -> Result<PersistedAcceptance, AuthorityPersistenceError> {
    let assigned_target = row.try_get::<Vec<u8>, _>("assigned_target")?;
    let received_at = row.try_get::<i64, _>("received_at_unix_seconds")?;
    let network_target_outcome = row.try_get::<String, _>("network_target_outcome")?;
    let canonical_matches = row.try_get::<String, _>("session_id")?
        == event.work_session_id().as_str()
        && assigned_target.as_slice() == event.assigned_target().to_be_bytes()
        && u64::try_from(received_at).ok() == Some(event.received_at().unix_seconds())
        && row.try_get::<String, _>("share_fingerprint")? == event.share_fingerprint().as_str()
        && network_target_outcome == event.network_target_outcome().as_str();
    if !canonical_matches {
        return Err(AuthorityPersistenceError::ConflictingEventReplay);
    }

    let maybe_credited_work = row
        .try_get::<Option<String>, _>("credited_work")?
        .map(CreditedWork::try_from)
        .transpose()?;
    let challenge_id = ChallengeId::try_from(row.try_get::<String, _>("challenge_id")?)?;
    let acknowledgement = AcceptedWorkAcknowledgement::persisted(PersistedAcknowledgementInput {
        event_id: AcceptedWorkEventId::try_from(row.try_get::<String, _>("event_id")?)?,
        work_session_id: WorkSessionId::try_from(row.try_get::<String, _>("session_id")?)?,
        received_at: ReceiptTime::try_from(
            u64::try_from(received_at)
                .map_err(|_| AuthorityPersistenceError::InvalidPersistedData)?,
        )?,
        network_target_outcome: NetworkTargetOutcome::parse(&network_target_outcome)?,
        disposition: AcceptedWorkDisposition::parse(&row.try_get::<String, _>("disposition")?)?,
        maybe_credited_work,
        verified_progress: VerifiedProgress::try_from(
            row.try_get::<String, _>("verified_progress")?,
        )?,
        work_requirement: CreditedWork::try_from(row.try_get::<String, _>("work_requirement")?)?,
        issuance_intent_created: row.try_get::<bool, _>("issuance_intent_created")?,
    });
    Ok(PersistedAcceptance {
        challenge_id,
        acknowledgement,
    })
}
