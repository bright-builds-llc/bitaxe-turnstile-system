use std::str::FromStr as _;

use async_trait::async_trait;
use sqlx::{PgPool, Row as _, postgres::PgPoolOptions};

mod accounting;

use accounting::{
    AcceptedEventRecordInput, challenge_for_session, insert_accepted_event, insert_issuance_intent,
    insert_share_fingerprint, persisted_acceptance, update_progress,
};

use super::{
    AuthorityPersistenceError, AuthorityRepository, ClaimedIssuance, PersistedAcceptance,
    PersistedIssuance, PersistedProgress,
};
use crate::{
    challenge::{ChallengeId, WorkChallengeDescriptor},
    crypto_profile::{GatePassClaimsSeed, GatePassClaimsTemplate},
    progress::{
        AcceptedWorkAcknowledgement, AcceptedWorkEvent, PersistedAcknowledgementInput,
        WorkSessionId,
    },
    work::{CreditedWork, VerifiedProgress},
};

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations/gate_authority");

pub(crate) struct PostgresAuthorityRepository {
    pool: PgPool,
}

impl PostgresAuthorityRepository {
    pub(crate) async fn connect(database_url: &str) -> Result<Self, AuthorityPersistenceError> {
        let bootstrap_pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(database_url)
            .await?;
        sqlx::query("CREATE SCHEMA IF NOT EXISTS gate_authority")
            .execute(&bootstrap_pool)
            .await?;
        bootstrap_pool.close().await;
        let connect_options = sqlx::postgres::PgConnectOptions::from_str(database_url)?
            .options([("search_path", "gate_authority,public")]);
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect_with(connect_options)
            .await?;
        MIGRATOR.run(&pool).await?;
        Ok(Self { pool })
    }
}

#[async_trait]
impl AuthorityRepository for PostgresAuthorityRepository {
    async fn insert_challenge(
        &self,
        descriptor: &WorkChallengeDescriptor,
        claims_seed: &GatePassClaimsSeed,
    ) -> Result<(), AuthorityPersistenceError> {
        let descriptor_json = serde_json::to_value(descriptor)
            .map_err(|_| AuthorityPersistenceError::InvalidPersistedData)?;
        let claims_seed = serde_json::to_value(claims_seed)
            .map_err(|_| AuthorityPersistenceError::InvalidPersistedData)?;
        let expires_at = i64::try_from(descriptor.expires_at_unix_seconds())
            .map_err(|_| AuthorityPersistenceError::InvalidPersistedData)?;
        let result = sqlx::query(include_str!("postgres/queries/insert_challenge.sql"))
            .bind(descriptor.challenge_id())
            .bind(descriptor_json)
            .bind(descriptor.required_work().to_decimal_string())
            .bind(expires_at)
            .bind(claims_seed)
            .execute(&self.pool)
            .await;

        match result {
            Ok(_) => Ok(()),
            Err(error)
                if error
                    .as_database_error()
                    .is_some_and(|error| error.is_unique_violation()) =>
            {
                Err(AuthorityPersistenceError::DuplicateChallenge)
            }
            Err(error) => Err(error.into()),
        }
    }

    async fn progress(
        &self,
        challenge_id: &ChallengeId,
    ) -> Result<PersistedProgress, AuthorityPersistenceError> {
        let maybe_row = sqlx::query_as::<_, (String, String, String)>(include_str!(
            "postgres/queries/select_progress.sql"
        ))
        .bind(challenge_id.as_str())
        .fetch_optional(&self.pool)
        .await?;
        let Some((challenge_id, verified_progress, work_requirement)) = maybe_row else {
            return Err(AuthorityPersistenceError::UnknownChallenge);
        };

        Ok(PersistedProgress {
            challenge_id: ChallengeId::try_from(challenge_id)?,
            verified_progress: VerifiedProgress::try_from(verified_progress)?,
            work_requirement: CreditedWork::try_from(work_requirement)?,
        })
    }

    async fn insert_work_session(
        &self,
        challenge_id: &ChallengeId,
        session_id: &WorkSessionId,
    ) -> Result<(), AuthorityPersistenceError> {
        let result = sqlx::query(include_str!("postgres/queries/insert_work_session.sql"))
            .bind(session_id.as_str())
            .bind(challenge_id.as_str())
            .execute(&self.pool)
            .await;

        match result {
            Ok(result) if result.rows_affected() == 0 => {
                Err(AuthorityPersistenceError::UnknownChallenge)
            }
            Ok(_) => Ok(()),
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

    async fn accept_work(
        &self,
        event: AcceptedWorkEvent,
    ) -> Result<PersistedAcceptance, AuthorityPersistenceError> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(event.event_id().as_str())
            .execute(&mut *transaction)
            .await?;

        let maybe_replay = sqlx::query(include_str!("postgres/queries/select_accepted_event.sql"))
            .bind(event.event_id().as_str())
            .fetch_optional(&mut *transaction)
            .await?;
        if let Some(row) = maybe_replay {
            let replay = persisted_acceptance(&row, &event)?;
            transaction.commit().await?;
            return Ok(replay);
        }

        let challenge_id = challenge_for_session(&mut transaction, &event).await?;
        let challenge = sqlx::query(include_str!("postgres/queries/lock_challenge_progress.sql"))
            .bind(&challenge_id)
            .fetch_one(&mut *transaction)
            .await?;
        let work_requirement =
            CreditedWork::try_from(challenge.try_get::<String, _>("work_requirement")?)?;
        let progress_before =
            VerifiedProgress::try_from(challenge.try_get::<String, _>("verified_progress")?)?;
        let already_satisfied = challenge.try_get::<bool, _>("satisfied")?;
        let signing_deadline = challenge.try_get::<i64, _>("expires_at_unix_seconds")?;
        let claims_seed = serde_json::from_value::<GatePassClaimsSeed>(
            challenge.try_get("gate_pass_claims_seed")?,
        )
        .map_err(|_| AuthorityPersistenceError::InvalidPersistedData)?;
        let challenge_expires_at = u64::try_from(signing_deadline)
            .map_err(|_| AuthorityPersistenceError::InvalidPersistedData)?;
        if already_satisfied != progress_before.meets(work_requirement) {
            return Err(AuthorityPersistenceError::InvalidPersistedData);
        }

        let fingerprint_inserted = insert_share_fingerprint(
            &mut transaction,
            event.share_fingerprint().as_str(),
            &challenge_id,
        )
        .await?;
        crate::progress::ensure_event_before_challenge_expiry(
            event.received_at().unix_seconds(),
            challenge_expires_at,
        )?;
        let transition = crate::progress::accepted_work_transition(
            crate::progress::AcceptedWorkTransitionInput {
                progress_before,
                work_requirement,
                credited_work: event.assigned_target().credited_work(),
                fingerprint_inserted,
            },
        )?;
        let disposition = transition.disposition;
        let maybe_credited_work = transition.maybe_credited_work;
        let verified_progress = transition.verified_progress;
        let satisfied = transition.satisfied;
        let issuance_intent_created = transition.issuance_intent_created;

        update_progress(
            &mut transaction,
            &challenge_id,
            verified_progress,
            satisfied,
        )
        .await?;
        if issuance_intent_created {
            insert_issuance_intent(
                &mut transaction,
                &challenge_id,
                signing_deadline,
                event.received_at().unix_seconds(),
                claims_seed,
            )
            .await?;
        }
        insert_accepted_event(
            &mut transaction,
            AcceptedEventRecordInput {
                challenge_id: &challenge_id,
                event: &event,
                disposition,
                maybe_credited_work,
                verified_progress,
                work_requirement,
                issuance_intent_created,
            },
        )
        .await?;

        let acknowledgement =
            AcceptedWorkAcknowledgement::persisted(PersistedAcknowledgementInput {
                event_id: event.event_id().clone(),
                work_session_id: event.work_session_id().clone(),
                received_at: event.received_at(),
                network_target_outcome: event.network_target_outcome(),
                disposition,
                maybe_credited_work,
                verified_progress,
                work_requirement,
                issuance_intent_created,
            });
        transaction.commit().await?;
        Ok(PersistedAcceptance {
            challenge_id: ChallengeId::try_from(challenge_id)?,
            acknowledgement,
        })
    }

    async fn maybe_claim_issuance(
        &self,
        worker_id: &str,
        now: u64,
        lease_expires_at: u64,
    ) -> Result<Option<ClaimedIssuance>, AuthorityPersistenceError> {
        let now = unix_seconds_to_i64(now)?;
        let lease_expires_at = unix_seconds_to_i64(lease_expires_at)?;
        let mut transaction = self.pool.begin().await?;
        sqlx::query(include_str!("postgres/queries/fail_expired_issuance.sql"))
            .bind(now)
            .execute(&mut *transaction)
            .await?;
        sqlx::query(
            "DELETE FROM gate_authority.claimant_issuance_proofs WHERE expires_at_unix_seconds < $1",
        )
        .bind(now)
        .execute(&mut *transaction)
        .await?;

        let maybe_row = sqlx::query(include_str!("postgres/queries/claim_issuance.sql"))
            .bind(now)
            .fetch_optional(&mut *transaction)
            .await?;
        let Some(row) = maybe_row else {
            transaction.commit().await?;
            return Ok(None);
        };
        let challenge_id = row.try_get::<String, _>("challenge_id")?;
        sqlx::query(include_str!("postgres/queries/mark_issuance_signing.sql"))
            .bind(&challenge_id)
            .bind(worker_id)
            .bind(lease_expires_at)
            .execute(&mut *transaction)
            .await?;
        sqlx::query(include_str!("postgres/queries/mark_outbox_processing.sql"))
            .bind(&challenge_id)
            .execute(&mut *transaction)
            .await?;
        let claimed = ClaimedIssuance {
            challenge_id: ChallengeId::try_from(challenge_id)?,
            algorithm: row.try_get("algorithm")?,
            claims_template: serde_json::from_value::<GatePassClaimsTemplate>(
                row.try_get("claims_template")?,
            )
            .map_err(|_| AuthorityPersistenceError::InvalidPersistedData)?,
        };
        transaction.commit().await?;
        Ok(Some(claimed))
    }

    async fn complete_issuance(
        &self,
        worker_id: &str,
        challenge_id: &ChallengeId,
        authority_kid: &str,
        gate_pass: &str,
        issued_at: u64,
        expires_at: u64,
    ) -> Result<(), AuthorityPersistenceError> {
        let mut transaction = self.pool.begin().await?;
        let result = sqlx::query(include_str!("postgres/queries/complete_issuance.sql"))
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
        sqlx::query(include_str!("postgres/queries/mark_outbox_completed.sql"))
            .bind(challenge_id.as_str())
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(())
    }

    async fn issuance(
        &self,
        challenge_id: &ChallengeId,
    ) -> Result<PersistedIssuance, AuthorityPersistenceError> {
        let maybe_row = sqlx::query_as::<_, (Option<String>, Option<String>)>(include_str!(
            "postgres/queries/select_issuance.sql"
        ))
        .bind(challenge_id.as_str())
        .fetch_optional(&self.pool)
        .await?;
        let Some((maybe_status, maybe_gate_pass)) = maybe_row else {
            return Err(AuthorityPersistenceError::UnknownChallenge);
        };
        match (maybe_status.as_deref(), maybe_gate_pass) {
            (None | Some("pending" | "signing"), None) => Ok(PersistedIssuance::Pending),
            (Some("issued"), Some(gate_pass)) => Ok(PersistedIssuance::Issued { gate_pass }),
            (Some("failed"), None) => Ok(PersistedIssuance::Failed),
            _ => Err(AuthorityPersistenceError::InvalidPersistedData),
        }
    }

    async fn challenge(
        &self,
        challenge_id: &ChallengeId,
    ) -> Result<WorkChallengeDescriptor, AuthorityPersistenceError> {
        let maybe_descriptor = sqlx::query_scalar::<_, serde_json::Value>(
            "SELECT descriptor FROM gate_authority.work_challenges WHERE challenge_id = $1",
        )
        .bind(challenge_id.as_str())
        .fetch_optional(&self.pool)
        .await?;
        let Some(descriptor) = maybe_descriptor else {
            return Err(AuthorityPersistenceError::UnknownChallenge);
        };
        serde_json::from_value(descriptor)
            .map_err(|_| AuthorityPersistenceError::InvalidPersistedData)
    }

    async fn consume_issuance_proof(
        &self,
        challenge_id: &ChallengeId,
        proof_id: &str,
        expires_at: u64,
        now: u64,
    ) -> Result<(), AuthorityPersistenceError> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query(
            "DELETE FROM gate_authority.claimant_issuance_proofs WHERE expires_at_unix_seconds < $1",
        )
        .bind(unix_seconds_to_i64(now)?)
        .execute(&mut *transaction)
        .await?;
        let result = sqlx::query(include_str!("postgres/queries/insert_claimant_proof.sql"))
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
}

fn unix_seconds_to_i64(value: u64) -> Result<i64, AuthorityPersistenceError> {
    i64::try_from(value).map_err(|_| AuthorityPersistenceError::InvalidPersistedData)
}
