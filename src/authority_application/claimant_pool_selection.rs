//! Claimant Pool Selection that keeps only the commitment at the Authority (ADR-0107).

use super::{
    AuthorityApplication, AuthorityApplicationError, current_unix_seconds,
    worker_lease::{PoolSelectionIntake, claimant_session_id},
};
use crate::{
    challenge::ChallengeId,
    pool_offer::{PoolSelection, PoolSelectionCommitment},
};

impl AuthorityApplication {
    /// Consents to one claimant choice, handing the raw choice to the Pool Adapter.
    ///
    /// The proposal records only the commitment; the Pool Adapter stores the raw choice
    /// before the commitment is confirmed, so a confirmed choice always has one.
    pub(crate) async fn claimant_select_pool(
        &self,
        challenge_id: &ChallengeId,
        selection: PoolSelection,
    ) -> Result<PoolSelectionCommitment, AuthorityApplicationError> {
        let issuance = self.worker_leases()?;
        let adapter = self.simulated_pool_adapter();
        let proposed = adapter
            .propose_pool_selection(challenge_id, &selection)
            .await?;
        let descriptor = self.repository.challenge(challenge_id).await?;
        issuance
            .stratum
            .record_pool_selection(PoolSelectionIntake {
                session_id: claimant_session_id(challenge_id)?,
                challenge_id: challenge_id.clone(),
                selection,
                challenge_expires_at_unix_seconds: descriptor.expires_at_unix_seconds(),
                now_unix_seconds: current_unix_seconds()?,
            })
            .await
            .map_err(|_| AuthorityApplicationError::WorkerStratumUnavailable)?;
        adapter
            .confirm_pool_selection(challenge_id, proposed.commitment())
            .await
    }

    /// Deletes a terminal challenge's raw choice at the Pool Adapter.
    ///
    /// The terminal transition has already committed, so a failure is logged rather than
    /// returned; lookup at expiry and the expiry sweep still delete the row.
    pub(super) async fn release_claimant_pool_selection(&self, challenge_id: &ChallengeId) {
        let Some(issuance) = &self.maybe_worker_leases else {
            return;
        };
        if let Err(error) = issuance.stratum.release_pool_selection(challenge_id).await {
            tracing::error!(%error, "terminal challenge's payout identity awaits expiry deletion");
        }
    }
}
