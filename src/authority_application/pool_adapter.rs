use uuid::Uuid;

use super::{
    AuthorityApplication, AuthorityApplicationError, current_unix_seconds,
    trusted_consent::binding_for_challenge,
};
use crate::{
    authority_persistence::{AuthorityPersistenceError, StartWorkLeaseInput},
    challenge::ChallengeId,
    lifecycle::{
        LifecycleError, SessionLifecycle, WORK_LEASE_MAX_DURATION_SECONDS,
        WORK_LEASE_RENEWAL_SECONDS, WorkLease, WorkerClock, WorkerInterruption,
    },
    pool_offer::{PoolSelection, PoolSelectionCommitment, verify_pool_offer_set},
    progress::{AcceptedWorkAcknowledgement, AcceptedWorkEvent, WorkSessionId},
    stratum_v1::{StratumLeaseContext, StratumUpstreamAuthorization},
    trusted_consent::{TrustedConsentLeaseAdmission, verify_trusted_consent_receipt},
};

/// Simulated Pool Adapter interface for the future authenticated gRPC transport.
#[derive(Clone)]
pub struct SimulatedPoolAdapter {
    pub(super) application: AuthorityApplication,
}

impl SimulatedPoolAdapter {
    /// Test-harness shortcut that explicitly selects and consents to an ephemeral test address.
    pub async fn consent_default_pool_offer_for_simulation(
        &self,
        challenge_id: &ChallengeId,
    ) -> Result<PoolSelectionCommitment, AuthorityApplicationError> {
        let selection = PoolSelection::bitcoin_address(
            "pool_offer_hydra_solo_v1".to_owned(),
            "1BoatSLRHtKNngkdXEeobR76b53LETtpyT".to_owned(),
        )?;
        self.consent_pool_selection_for_simulation(challenge_id, &selection)
            .await
    }

    /// Test-harness shortcut that consents to one exact Pool Adapter-owned selection.
    pub async fn consent_pool_selection_for_simulation(
        &self,
        challenge_id: &ChallengeId,
        selection: &PoolSelection,
    ) -> Result<PoolSelectionCommitment, AuthorityApplicationError> {
        let proposed = self.propose_pool_selection(challenge_id, selection).await?;
        self.confirm_pool_selection(challenge_id, proposed.commitment())
            .await
    }

    /// Resolves one Pool-facing authorization from the Authority-retained session binding.
    pub async fn upstream_authorization_for_simulation(
        &self,
        session_id: &WorkSessionId,
        selection: &PoolSelection,
        secret: String,
    ) -> Result<StratumUpstreamAuthorization, AuthorityApplicationError> {
        let retained = self
            .application
            .repository
            .session_pool_selection(session_id)
            .await?;
        StratumUpstreamAuthorization::from_authority_binding(
            &retained.challenge_id,
            session_id.clone(),
            selection,
            retained.selection,
            secret,
        )
        .map_err(|_| AuthorityApplicationError::InvalidUpstreamAuthorization)
    }

    /// Proposes an approved offer and raw payout choice while persisting only its commitment.
    pub async fn propose_pool_selection(
        &self,
        challenge_id: &ChallengeId,
        selection: &PoolSelection,
    ) -> Result<PoolSelectionCommitment, AuthorityApplicationError> {
        let descriptor = self.application.repository.challenge(challenge_id).await?;
        let signed_offers = descriptor
            .maybe_pool_offers()
            .ok_or(AuthorityApplicationError::PoolSelectionRequired)?;
        let verified_offers = verify_pool_offer_set(
            signed_offers,
            self.application.config.issuer(),
            descriptor.challenge_id(),
            descriptor.action_policy(),
            self.application.config.verification_keys(),
        )?;
        let maybe_offer = verified_offers
            .offers()
            .iter()
            .find(|offer| offer.offer_id() == selection.offer_id());
        let Some(offer) = maybe_offer else {
            return Err(AuthorityApplicationError::UnknownPoolOffer);
        };
        if !offer.accepts_selection(selection) {
            return Err(AuthorityApplicationError::InvalidPoolSelection);
        }
        let commitment = selection.commitment(challenge_id.as_str());
        Ok(self
            .application
            .repository
            .propose_pool_selection(
                challenge_id,
                selection.offer_id(),
                &commitment,
                current_unix_seconds()?,
            )
            .await?)
    }

    /// Locks the exact proposed offer and payout commitment as part of Work Consent.
    pub async fn confirm_pool_selection(
        &self,
        challenge_id: &ChallengeId,
        payout_commitment: &str,
    ) -> Result<PoolSelectionCommitment, AuthorityApplicationError> {
        Ok(self
            .application
            .repository
            .confirm_pool_selection(challenge_id, payout_commitment, current_unix_seconds()?)
            .await?)
    }

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
        self.start_lease_internal(session_id, clock, None).await
    }

    /// Starts one bounded consequential lease with an Authority-signed Trusted Consent Receipt.
    pub async fn start_lease_with_trusted_consent(
        &self,
        session_id: &WorkSessionId,
        clock: WorkerClock,
        compact_receipt: &str,
    ) -> Result<WorkLease, AuthorityApplicationError> {
        let now = current_unix_seconds()?;
        let retained = self
            .application
            .repository
            .session_pool_selection(session_id)
            .await?;
        let descriptor = self
            .application
            .repository
            .challenge(&retained.challenge_id)
            .await?;
        let signed_offers = descriptor
            .maybe_pool_offers()
            .ok_or(AuthorityApplicationError::InvalidTrustedConsentReceipt)?;
        let verified_offers = verify_pool_offer_set(
            signed_offers,
            self.application.config.issuer(),
            descriptor.challenge_id(),
            descriptor.action_policy(),
            self.application.config.verification_keys(),
        )?;
        if !verified_offers.trusted_confirmation_required() {
            return Err(AuthorityApplicationError::InvalidTrustedConsentReceipt);
        }
        let binding = binding_for_challenge(&descriptor, self.application.config.issuer())?;
        let verified_receipt = verify_trusted_consent_receipt(
            compact_receipt,
            self.application.config.issuer(),
            &binding,
            self.application.config.verification_keys(),
            now,
        )
        .map_err(|_| AuthorityApplicationError::InvalidTrustedConsentReceipt)?;
        let admission = TrustedConsentLeaseAdmission::new(compact_receipt, verified_receipt);
        self.start_lease_internal(session_id, clock, Some(&admission))
            .await
    }

    async fn start_lease_internal(
        &self,
        session_id: &WorkSessionId,
        clock: WorkerClock,
        maybe_trusted_consent: Option<&TrustedConsentLeaseAdmission<'_>>,
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
            .start_work_lease(StartWorkLeaseInput {
                session_id,
                maybe_trusted_consent,
                clock: &clock,
                lease_id: &lease_id,
                renew_at_monotonic_milliseconds: renew_at,
                expires_at_monotonic_milliseconds: expires_at,
                now_unix_seconds: current_unix_seconds()?,
            })
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

    /// Applies one Pool Adapter event using its exact durably captured lease context.
    pub async fn report_stratum(
        &self,
        event: AcceptedWorkEvent,
        context: &StratumLeaseContext,
    ) -> Result<AcceptedWorkAcknowledgement, AuthorityApplicationError> {
        let lease = WorkLease::persisted(
            context.lease_id().to_owned(),
            context.renew_at_monotonic_milliseconds(),
            context.expires_at_monotonic_milliseconds(),
        );
        let clock = WorkerClock::new(
            context.continuity_id(),
            context.last_monotonic_milliseconds(),
        )?;
        self.application.accept_work(event, &lease, &clock).await
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
