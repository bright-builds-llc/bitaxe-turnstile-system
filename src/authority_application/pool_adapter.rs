use uuid::Uuid;

use super::{AuthorityApplication, AuthorityApplicationError, current_unix_seconds};
use crate::{
    authority_persistence::AuthorityPersistenceError,
    challenge::ChallengeId,
    lifecycle::{
        LifecycleError, SessionLifecycle, WORK_LEASE_MAX_DURATION_SECONDS,
        WORK_LEASE_RENEWAL_SECONDS, WorkLease, WorkerClock, WorkerInterruption,
    },
    progress::{AcceptedWorkAcknowledgement, AcceptedWorkEvent, WorkSessionId},
};

/// Simulated Pool Adapter interface for the future authenticated gRPC transport.
#[derive(Clone)]
pub struct SimulatedPoolAdapter {
    pub(super) application: AuthorityApplication,
}

impl SimulatedPoolAdapter {
    /// Binds one ready Work Session to its immutable Work Challenge without starting work.
    pub async fn register_session(
        &self,
        challenge_id: &ChallengeId,
        session_id: WorkSessionId,
    ) -> Result<(), AuthorityApplicationError> {
        self.application
            .insert_work_session(challenge_id, &session_id)
            .await
    }

    /// Starts one bounded lease after a ready or safely restored session.
    pub async fn start_lease(
        &self,
        session_id: &WorkSessionId,
        clock: WorkerClock,
    ) -> Result<WorkLease, AuthorityApplicationError> {
        let renew_at =
            monotonic_deadline(clock.monotonic_milliseconds(), WORK_LEASE_RENEWAL_SECONDS)?;
        let expires_at = monotonic_deadline(
            clock.monotonic_milliseconds(),
            WORK_LEASE_MAX_DURATION_SECONDS,
        )?;
        let lease_id = Uuid::new_v4().to_string();
        let lease = self
            .application
            .repository
            .start_work_lease(
                session_id,
                &clock,
                &lease_id,
                renew_at,
                expires_at,
                current_unix_seconds()?,
            )
            .await?;
        self.application
            .notify_lifecycle_for_session(session_id)
            .await?;
        Ok(lease)
    }

    /// Renews the active lease only while its boot and monotonic continuity remain valid.
    pub async fn renew_lease(
        &self,
        session_id: &WorkSessionId,
        lease_id: &str,
        clock: WorkerClock,
    ) -> Result<WorkLease, AuthorityApplicationError> {
        let renew_at =
            monotonic_deadline(clock.monotonic_milliseconds(), WORK_LEASE_RENEWAL_SECONDS)?;
        let expires_at = monotonic_deadline(
            clock.monotonic_milliseconds(),
            WORK_LEASE_MAX_DURATION_SECONDS,
        )?;
        let result = self
            .application
            .repository
            .renew_work_lease(
                session_id,
                lease_id,
                &clock,
                renew_at,
                expires_at,
                current_unix_seconds()?,
            )
            .await;
        if matches!(
            result,
            Err(AuthorityPersistenceError::WorkerContinuityLost
                | AuthorityPersistenceError::WorkLeaseExpired)
        ) {
            self.application
                .notify_lifecycle_for_session(session_id)
                .await?;
        }
        result.map_err(Into::into)
    }

    /// Ends a lease when Worker time or boot continuity is no longer trustworthy.
    pub async fn interrupt(
        &self,
        session_id: &WorkSessionId,
        interruption: WorkerInterruption,
    ) -> Result<(), AuthorityApplicationError> {
        self.application
            .repository
            .interrupt_work_session(session_id, interruption)
            .await?;
        self.application
            .notify_lifecycle_for_session(session_id)
            .await?;
        Ok(())
    }

    /// Records the Worker's confirmation that its Mining Baseline was restored.
    pub async fn confirm_restored(
        &self,
        session_id: &WorkSessionId,
    ) -> Result<(), AuthorityApplicationError> {
        self.application
            .repository
            .confirm_work_session_restored(session_id)
            .await?;
        self.application
            .notify_lifecycle_for_session(session_id)
            .await?;
        Ok(())
    }

    /// Marks a session irrecoverably unsafe while leaving its challenge free to use another one.
    pub async fn fail_session(
        &self,
        session_id: &WorkSessionId,
    ) -> Result<(), AuthorityApplicationError> {
        self.application
            .repository
            .fail_work_session(session_id)
            .await?;
        self.application
            .notify_lifecycle_for_session(session_id)
            .await?;
        Ok(())
    }

    /// Reads the durable Work Session state without exposing it over the Authority HTTP API.
    pub async fn session_lifecycle(
        &self,
        session_id: &WorkSessionId,
    ) -> Result<SessionLifecycle, AuthorityApplicationError> {
        Ok(self
            .application
            .repository
            .work_session_lifecycle(session_id)
            .await?)
    }

    /// Atomically records one target-qualified accepted result and its stable acknowledgement.
    pub async fn report(
        &self,
        event: AcceptedWorkEvent,
        lease: &WorkLease,
        clock: WorkerClock,
    ) -> Result<AcceptedWorkAcknowledgement, AuthorityApplicationError> {
        self.application.accept_work(event, lease, &clock).await
    }
}

fn monotonic_deadline(now_milliseconds: u64, duration_seconds: u64) -> Result<u64, LifecycleError> {
    now_milliseconds
        .checked_add(
            duration_seconds
                .checked_mul(1_000)
                .ok_or(LifecycleError::DeadlineOverflow)?,
        )
        .ok_or(LifecycleError::DeadlineOverflow)
}
