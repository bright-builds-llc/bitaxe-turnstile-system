use std::str::FromStr as _;

use async_trait::async_trait;
use sqlx::{PgPool, Row as _, postgres::PgPoolOptions};

mod accounting;
mod lifecycle;
mod pool_selection;

use accounting::{
    AcceptedEventRecordInput, challenge_for_session, insert_accepted_event, insert_issuance_intent,
    insert_share_fingerprint, observe_session_lease, persisted_acceptance, update_progress,
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
        now: u64,
    ) -> Result<(), AuthorityPersistenceError> {
        pool_selection::insert_work_session(&self.pool, challenge_id, session_id, now).await
    }

    async fn session_pool_selection(
        &self,
        session_id: &crate::progress::WorkSessionId,
    ) -> Result<
        crate::authority_persistence::PersistedSessionPoolSelection,
        AuthorityPersistenceError,
    > {
        pool_selection::session_pool_selection(&self.pool, session_id).await
    }

    async fn challenge_lifecycle(
        &self,
        challenge_id: &ChallengeId,
        now: u64,
    ) -> Result<crate::lifecycle::ChallengeLifecycle, AuthorityPersistenceError> {
        lifecycle::challenge_lifecycle(&self.pool, challenge_id, now).await
    }

    async fn propose_pool_selection(
        &self,
        challenge_id: &ChallengeId,
        pool_offer_id: &str,
        payout_commitment: &str,
        now: u64,
    ) -> Result<crate::pool_offer::PoolSelectionCommitment, AuthorityPersistenceError> {
        pool_selection::propose_pool_selection(
            &self.pool,
            challenge_id,
            pool_offer_id,
            payout_commitment,
            now,
        )
        .await
    }

    async fn confirm_pool_selection(
        &self,
        challenge_id: &ChallengeId,
        payout_commitment: &str,
        now: u64,
    ) -> Result<crate::pool_offer::PoolSelectionCommitment, AuthorityPersistenceError> {
        pool_selection::confirm_pool_selection(&self.pool, challenge_id, payout_commitment, now)
            .await
    }

    async fn pause_challenge(
        &self,
        challenge_id: &ChallengeId,
        reason: crate::lifecycle::PauseReason,
        now: u64,
    ) -> Result<crate::lifecycle::ChallengeLifecycle, AuthorityPersistenceError> {
        lifecycle::pause_challenge(&self.pool, challenge_id, reason, now).await
    }

    async fn cancel_challenge(
        &self,
        challenge_id: &ChallengeId,
        now: u64,
    ) -> Result<crate::lifecycle::ChallengeLifecycle, AuthorityPersistenceError> {
        lifecycle::cancel_challenge(&self.pool, challenge_id, now).await
    }

    async fn start_work_lease(
        &self,
        session_id: &WorkSessionId,
        clock: &crate::lifecycle::WorkerClock,
        lease_id: &str,
        renew_at_monotonic_milliseconds: u64,
        expires_at_monotonic_milliseconds: u64,
        now: u64,
    ) -> Result<crate::lifecycle::WorkLease, AuthorityPersistenceError> {
        lifecycle::start_work_lease(
            &self.pool,
            session_id,
            clock,
            lease_id,
            renew_at_monotonic_milliseconds,
            expires_at_monotonic_milliseconds,
            now,
        )
        .await
    }

    async fn renew_work_lease(
        &self,
        session_id: &WorkSessionId,
        lease_id: &str,
        clock: &crate::lifecycle::WorkerClock,
        renew_at_monotonic_milliseconds: u64,
        expires_at_monotonic_milliseconds: u64,
        now: u64,
    ) -> Result<crate::lifecycle::WorkLease, AuthorityPersistenceError> {
        lifecycle::renew_work_lease(
            &self.pool,
            session_id,
            lease_id,
            clock,
            renew_at_monotonic_milliseconds,
            expires_at_monotonic_milliseconds,
            now,
        )
        .await
    }

    async fn interrupt_work_session(
        &self,
        session_id: &WorkSessionId,
        interruption: crate::lifecycle::WorkerInterruption,
    ) -> Result<(), AuthorityPersistenceError> {
        lifecycle::interrupt_work_session(&self.pool, session_id, interruption).await
    }

    async fn confirm_work_session_restored(
        &self,
        session_id: &WorkSessionId,
    ) -> Result<(), AuthorityPersistenceError> {
        lifecycle::confirm_work_session_restored(&self.pool, session_id).await
    }

    async fn fail_work_session(
        &self,
        session_id: &WorkSessionId,
    ) -> Result<(), AuthorityPersistenceError> {
        lifecycle::fail_work_session(&self.pool, session_id).await
    }

    async fn work_session_lifecycle(
        &self,
        session_id: &WorkSessionId,
    ) -> Result<crate::lifecycle::SessionLifecycle, AuthorityPersistenceError> {
        lifecycle::work_session_lifecycle(&self.pool, session_id).await
    }

    async fn accept_work(
        &self,
        event: AcceptedWorkEvent,
        lease_id: &str,
        clock: &crate::lifecycle::WorkerClock,
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
        let lifecycle_state = crate::lifecycle::ChallengeLifecycleState::parse(
            challenge.try_get("lifecycle_state")?,
        )?;
        crate::lifecycle::apply_challenge_command(
            lifecycle_state,
            crate::lifecycle::ChallengeLifecycleCommand::AcceptWork,
        )
        .map_err(|_| AuthorityPersistenceError::ForbiddenLifecycleTransition)?;
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

        if let Err(error) = crate::progress::ensure_event_before_challenge_expiry(
            event.received_at().unix_seconds(),
            challenge_expires_at,
        ) {
            sqlx::query(
                "UPDATE gate_authority.work_challenges
                 SET lifecycle_state = 'expired',
                     lifecycle_changed_at_unix_seconds = $2,
                     terminal_at_unix_seconds = $2
                 WHERE challenge_id = $1",
            )
            .bind(&challenge_id)
            .bind(signing_deadline)
            .execute(&mut *transaction)
            .await?;
            sqlx::query(
                "UPDATE gate_authority.work_sessions
                 SET lifecycle_state = 'stopping', lease_id = NULL, continuity_id = NULL,
                     last_monotonic_milliseconds = NULL,
                     renew_at_monotonic_milliseconds = NULL,
                     expires_at_monotonic_milliseconds = NULL, stop_reason = $2
                 WHERE challenge_id = $1 AND lifecycle_state IN ('ready', 'leased')",
            )
            .bind(&challenge_id)
            .bind(crate::lifecycle::SessionStopReason::ChallengeExpired.as_str())
            .execute(&mut *transaction)
            .await?;
            transaction.commit().await?;
            return Err(error.into());
        }
        let lease_observation =
            observe_session_lease(&mut transaction, &event, &challenge_id, lease_id, clock).await?;
        if let crate::lifecycle::LeaseObservation::Stop(reason) = lease_observation {
            transaction.commit().await?;
            return Err(match reason {
                crate::lifecycle::SessionStopReason::LeaseExpired => {
                    AuthorityPersistenceError::WorkLeaseExpired
                }
                crate::lifecycle::SessionStopReason::WorkerReboot
                | crate::lifecycle::SessionStopReason::MonotonicReset => {
                    AuthorityPersistenceError::WorkerContinuityLost
                }
                _ => AuthorityPersistenceError::InvalidPersistedData,
            });
        }
        let fingerprint_inserted = insert_share_fingerprint(
            &mut transaction,
            event.share_fingerprint().as_str(),
            &challenge_id,
        )
        .await?;
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
        if issuance_intent_created {
            crate::lifecycle::apply_challenge_command(
                lifecycle_state,
                crate::lifecycle::ChallengeLifecycleCommand::Satisfy,
            )
            .map_err(|_| AuthorityPersistenceError::ForbiddenLifecycleTransition)?;
        }

        update_progress(
            &mut transaction,
            &challenge_id,
            verified_progress,
            satisfied,
            event.received_at().unix_seconds(),
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
            sqlx::query(
                "UPDATE gate_authority.work_sessions
                 SET lifecycle_state = 'stopping', lease_id = NULL, continuity_id = NULL,
                     last_monotonic_milliseconds = NULL,
                     renew_at_monotonic_milliseconds = NULL,
                     expires_at_monotonic_milliseconds = NULL, stop_reason = $2
                 WHERE challenge_id = $1 AND lifecycle_state = 'leased'",
            )
            .bind(&challenge_id)
            .bind(crate::lifecycle::SessionStopReason::ChallengeSatisfied.as_str())
            .execute(&mut *transaction)
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
        sqlx::query(include_str!("postgres/queries/mark_challenge_issued.sql"))
            .bind(challenge_id.as_str())
            .bind(unix_seconds_to_i64(issued_at)?)
            .execute(&mut *transaction)
            .await?;
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
        let maybe_row = sqlx::query_as::<_, (Option<String>, Option<String>, Option<i64>)>(
            include_str!("postgres/queries/select_issuance.sql"),
        )
        .bind(challenge_id.as_str())
        .fetch_optional(&self.pool)
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
