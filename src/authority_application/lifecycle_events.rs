use std::time::Duration;

use tokio::sync::broadcast;

use super::{
    AuthorityApplication, AuthorityApplicationError, PROGRESS_CHANNEL_CAPACITY,
    current_unix_seconds,
};
use crate::{challenge::ChallengeId, lifecycle::ChallengeLifecycle, progress::WorkSessionId};

impl AuthorityApplication {
    pub(crate) async fn subscribe_lifecycle(
        &self,
        challenge_id: &ChallengeId,
        now: u64,
    ) -> Result<
        (ChallengeLifecycle, broadcast::Receiver<ChallengeLifecycle>),
        AuthorityApplicationError,
    > {
        let snapshot = self.challenge_lifecycle(challenge_id, now).await?;
        if snapshot.authorization_eligible() {
            self.schedule_lifecycle_expiry(
                challenge_id.clone(),
                snapshot.lifecycle_deadline_unix_seconds(),
            );
        }
        let mut channels = self
            .lifecycle_channels
            .lock()
            .map_err(|_| AuthorityApplicationError::StateUnavailable)?;
        let channel = channels.entry(challenge_id.clone()).or_insert_with(|| {
            let (updates, _receiver) = broadcast::channel(PROGRESS_CHANNEL_CAPACITY);
            updates
        });
        Ok((snapshot, channel.subscribe()))
    }

    pub(super) fn notify_lifecycle(
        &self,
        challenge_id: &ChallengeId,
        lifecycle: ChallengeLifecycle,
    ) -> Result<(), AuthorityApplicationError> {
        let maybe_updates = self
            .lifecycle_channels
            .lock()
            .map_err(|_| AuthorityApplicationError::StateUnavailable)?
            .get(challenge_id)
            .cloned();
        let Some(updates) = maybe_updates else {
            return Ok(());
        };
        if updates.receiver_count() > 0
            && let Err(error) = updates.send(lifecycle)
        {
            tracing::debug!(%error, "lifecycle subscriber disconnected before notification");
        }
        Ok(())
    }

    pub(super) async fn notify_lifecycle_for_session(
        &self,
        session_id: &WorkSessionId,
    ) -> Result<(), AuthorityApplicationError> {
        let session = self.repository.work_session_lifecycle(session_id).await?;
        let lifecycle = self
            .repository
            .challenge_lifecycle(session.challenge_id(), current_unix_seconds()?)
            .await?;
        self.notify_lifecycle(session.challenge_id(), lifecycle)
    }

    pub(super) fn schedule_lifecycle_expiry(&self, challenge_id: ChallengeId, deadline: u64) {
        let mut deadlines = match self.lifecycle_expiry_deadlines.lock() {
            Ok(deadlines) => deadlines,
            Err(error) => {
                tracing::error!(%error, "cannot schedule lifecycle expiry without application state");
                return;
            }
        };
        if deadlines.get(&challenge_id) == Some(&deadline) {
            return;
        }
        deadlines.insert(challenge_id.clone(), deadline);
        drop(deadlines);
        let application = self.clone();
        tokio::spawn(async move {
            let as_of = loop {
                match current_unix_seconds() {
                    Ok(now) if now >= deadline => break now,
                    Ok(now) => {
                        tokio::time::sleep(Duration::from_secs(deadline - now)).await;
                    }
                    Err(error) => {
                        tracing::error!(%error, "lifecycle expiry is waiting for a valid clock");
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                }
            };
            loop {
                let is_current = application
                    .lifecycle_expiry_deadlines
                    .lock()
                    .is_ok_and(|deadlines| deadlines.get(&challenge_id) == Some(&deadline));
                if !is_current {
                    return;
                }
                match application
                    .repository
                    .challenge_lifecycle(&challenge_id, as_of)
                    .await
                {
                    Ok(lifecycle) => {
                        if let Ok(mut deadlines) = application.lifecycle_expiry_deadlines.lock()
                            && deadlines.get(&challenge_id) == Some(&deadline)
                        {
                            deadlines.remove(&challenge_id);
                        }
                        if lifecycle.state() == crate::lifecycle::ChallengeLifecycleState::Expired
                            && let Err(error) =
                                application.notify_lifecycle(&challenge_id, lifecycle)
                        {
                            tracing::debug!(%error, "lifecycle expiry notification failed");
                        }
                        return;
                    }
                    Err(error) => {
                        tracing::debug!(%error, "scheduled lifecycle expiry will retry");
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                }
            }
        });
    }

    pub(super) fn cancel_scheduled_expiry(
        &self,
        challenge_id: &ChallengeId,
    ) -> Result<(), AuthorityApplicationError> {
        self.lifecycle_expiry_deadlines
            .lock()
            .map_err(|_| AuthorityApplicationError::StateUnavailable)?
            .remove(challenge_id);
        Ok(())
    }
}
