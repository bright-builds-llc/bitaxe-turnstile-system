use sqlx::{Postgres, Transaction};

use crate::{
    authority_persistence::AuthorityPersistenceError,
    lifecycle::{ChallengeLifecycleState, SessionLifecycleState},
    progress::WorkSessionId,
    trusted_consent::TrustedConsentLeaseAdmission,
};

pub(super) struct LockedLeaseContext {
    pub(super) challenge_id: String,
    pub(super) challenge_state: ChallengeLifecycleState,
    pub(super) session_state: SessionLifecycleState,
    pub(super) selection_consented: bool,
    pub(super) trusted_confirmation_required: bool,
    pub(super) maybe_trusted_consent_ceremony_id: Option<String>,
}

pub(super) async fn admit(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: &WorkSessionId,
    locked: &LockedLeaseContext,
    maybe_admission: Option<&TrustedConsentLeaseAdmission<'_>>,
    now: u64,
) -> Result<(), AuthorityPersistenceError> {
    if !locked.trusted_confirmation_required {
        if maybe_admission.is_some() {
            return Err(AuthorityPersistenceError::InvalidTrustedConsentReceipt);
        }
        return Ok(());
    }
    let admission = maybe_admission.ok_or(AuthorityPersistenceError::TrustedConsentRequired)?;
    if admission.challenge_id() != locked.challenge_id {
        return Err(AuthorityPersistenceError::InvalidTrustedConsentReceipt);
    }
    if let Some(existing) = &locked.maybe_trusted_consent_ceremony_id {
        if existing == admission.ceremony_id() {
            return Ok(());
        }
        return Err(AuthorityPersistenceError::InvalidTrustedConsentReceipt);
    }
    let maybe_ceremony_id = sqlx::query_scalar::<_, String>(
        "SELECT ceremony_id FROM gate_authority.trusted_consent_ceremonies
         WHERE ceremony_id = $1 AND challenge_id = $2 AND status = 'verified'
           AND trusted_consent_receipt = $3
           AND receipt_expires_at_unix_seconds = $4
           AND receipt_expires_at_unix_seconds > $5
         FOR UPDATE",
    )
    .bind(admission.ceremony_id())
    .bind(admission.challenge_id())
    .bind(admission.compact_receipt())
    .bind(to_i64(admission.expires_at_unix_seconds())?)
    .bind(to_i64(now)?)
    .fetch_optional(&mut **transaction)
    .await?;
    if maybe_ceremony_id.is_none() {
        return Err(AuthorityPersistenceError::InvalidTrustedConsentReceipt);
    }
    let result = sqlx::query(
        "UPDATE gate_authority.work_sessions
         SET trusted_consent_ceremony_id = $2
         WHERE session_id = $1 AND trusted_consent_ceremony_id IS NULL",
    )
    .bind(session_id.as_str())
    .bind(admission.ceremony_id())
    .execute(&mut **transaction)
    .await;
    match result {
        Ok(result) if result.rows_affected() == 1 => Ok(()),
        Ok(_) => Err(AuthorityPersistenceError::InvalidTrustedConsentReceipt),
        Err(error)
            if error
                .as_database_error()
                .is_some_and(|error| error.is_unique_violation()) =>
        {
            Err(AuthorityPersistenceError::TrustedConsentReceiptReplayed)
        }
        Err(error) => Err(error.into()),
    }
}

fn to_i64(value: u64) -> Result<i64, AuthorityPersistenceError> {
    i64::try_from(value).map_err(|_| AuthorityPersistenceError::InvalidPersistedData)
}
