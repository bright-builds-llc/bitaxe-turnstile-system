use sqlx::{Row as _, postgres::PgRow};
use uuid::Uuid;

use super::unix_seconds_to_i64;
use crate::{
    authority_persistence::{AuthorityPersistenceError, PersistedAcceptance},
    challenge::ChallengeId,
    crypto_profile::{GATE_PASS_JWS_ALGORITHM, GatePassClaimsSeed},
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
    sqlx::query_scalar::<_, String>(
        "SELECT challenge_id FROM gate_authority.work_sessions WHERE session_id = $1",
    )
    .bind(event.work_session_id().as_str())
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or(AuthorityPersistenceError::UnknownWorkSession)
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
) -> Result<(), AuthorityPersistenceError> {
    sqlx::query(include_str!("queries/update_progress.sql"))
        .bind(challenge_id)
        .bind(verified_progress.to_decimal_string())
        .bind(satisfied)
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
