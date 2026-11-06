//! Credits one Accepted Work Event, or refuses it terminally (ADR-0108).

use super::{
    AuthorityApplication, AuthorityApplicationError, ProgressUpdate, current_unix_seconds,
};
use crate::{
    lifecycle::{WorkLease, WorkerClock},
    progress::{AcceptedWorkAcknowledgement, AcceptedWorkEvent, AcceptedWorkRefusal},
};

impl AuthorityApplication {
    pub(super) async fn accept_work(
        &self,
        event: AcceptedWorkEvent,
        lease: &WorkLease,
        clock: &WorkerClock,
    ) -> Result<AcceptedWorkAcknowledgement, AuthorityApplicationError> {
        let session_id = event.work_session_id().clone();
        let acceptance = match self
            .repository
            .accept_work(event, lease.lease_id(), clock, current_unix_seconds()?)
            .await
        {
            Ok(acceptance) => acceptance,
            Err(error) => {
                let application_error = AuthorityApplicationError::from(error);
                if matches!(
                    application_error,
                    AuthorityApplicationError::WorkRefused(
                        AcceptedWorkRefusal::WorkerContinuityLost
                            | AcceptedWorkRefusal::WorkLeaseExpired
                    )
                ) {
                    self.notify_lifecycle_for_session(&session_id).await?;
                }
                return Err(application_error);
            }
        };
        let update = ProgressUpdate::persisted(
            acceptance.challenge_id.clone(),
            acceptance.acknowledgement.verified_progress(),
            acceptance.acknowledgement.work_requirement(),
        );
        self.notify_progress(&acceptance.challenge_id, update)?;
        if acceptance.acknowledgement.issuance_intent_created() {
            self.release_claimant_pool_selection(&acceptance.challenge_id)
                .await;
            let lifecycle = self
                .repository
                .challenge_lifecycle(&acceptance.challenge_id, current_unix_seconds()?)
                .await?;
            self.notify_lifecycle(&acceptance.challenge_id, lifecycle)?;
        }
        Ok(acceptance.acknowledgement)
    }
}
