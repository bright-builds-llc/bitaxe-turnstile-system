//! Per-challenge broadcast channels behind the challenge events SSE stream.

use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex},
};

use tokio::sync::broadcast;

use super::{AuthorityApplicationError, PROGRESS_CHANNEL_CAPACITY};
use crate::challenge::ChallengeId;

/// One broadcast channel per challenge, carrying full snapshots of type `T`.
#[derive(Clone)]
pub(super) struct ChallengeChannels<T> {
    channels: Arc<Mutex<HashMap<ChallengeId, broadcast::Sender<T>>>>,
}

impl<T: Clone> ChallengeChannels<T> {
    pub(super) fn new() -> Self {
        Self {
            channels: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Subscribes to the challenge, then reads its snapshot with `read_snapshot`.
    ///
    /// Subscribing first means an update sent while the snapshot is being read still
    /// reaches the receiver. The stream may see that state twice, which is harmless because
    /// every update is a full snapshot, but it never misses it. A failed read removes the
    /// channel again unless another stream is subscribed, so unknown challenge IDs leave
    /// nothing behind.
    pub(super) async fn subscribe_then_read<S, F, Fut>(
        &self,
        challenge_id: &ChallengeId,
        read_snapshot: F,
    ) -> Result<(S, broadcast::Receiver<T>), AuthorityApplicationError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<S, AuthorityApplicationError>>,
    {
        let receiver = self.subscribe(challenge_id)?;
        match read_snapshot().await {
            Ok(snapshot) => Ok((snapshot, receiver)),
            Err(error) => {
                drop(receiver);
                self.remove_if_unsubscribed(challenge_id)?;
                Err(error)
            }
        }
    }

    /// Sends `update` to every current subscriber of the challenge.
    pub(super) fn notify(
        &self,
        challenge_id: &ChallengeId,
        update: T,
    ) -> Result<(), AuthorityApplicationError> {
        let maybe_updates = self
            .channels
            .lock()
            .map_err(|_| AuthorityApplicationError::StateUnavailable)?
            .get(challenge_id)
            .cloned();
        let Some(updates) = maybe_updates else {
            return Ok(());
        };
        if updates.receiver_count() > 0
            && let Err(error) = updates.send(update)
        {
            tracing::debug!(%error, "challenge subscriber disconnected before notification");
        }
        Ok(())
    }

    fn subscribe(
        &self,
        challenge_id: &ChallengeId,
    ) -> Result<broadcast::Receiver<T>, AuthorityApplicationError> {
        let mut channels = self
            .channels
            .lock()
            .map_err(|_| AuthorityApplicationError::StateUnavailable)?;
        let channel = channels.entry(challenge_id.clone()).or_insert_with(|| {
            let (updates, _receiver) = broadcast::channel(PROGRESS_CHANNEL_CAPACITY);
            updates
        });
        Ok(channel.subscribe())
    }

    fn remove_if_unsubscribed(
        &self,
        challenge_id: &ChallengeId,
    ) -> Result<(), AuthorityApplicationError> {
        let mut channels = self
            .channels
            .lock()
            .map_err(|_| AuthorityApplicationError::StateUnavailable)?;
        if channels
            .get(challenge_id)
            .is_some_and(|updates| updates.receiver_count() == 0)
        {
            channels.remove(challenge_id);
        }
        Ok(())
    }

    #[cfg(test)]
    fn has_channel(&self, challenge_id: &ChallengeId) -> bool {
        self.channels
            .lock()
            .is_ok_and(|channels| channels.contains_key(challenge_id))
    }
}

#[cfg(test)]
mod tests {
    use std::error::Error;

    use super::*;

    fn challenge_id() -> Result<ChallengeId, Box<dyn Error>> {
        Ok(ChallengeId::try_from("challenge_channels01".to_owned())?)
    }

    #[tokio::test]
    async fn update_sent_while_the_snapshot_is_read_reaches_the_new_subscriber()
    -> Result<(), Box<dyn Error>> {
        // Arrange
        let channels = ChallengeChannels::<&'static str>::new();
        let challenge_id = challenge_id()?;

        // Act
        let (snapshot, mut receiver) = channels
            .subscribe_then_read(&challenge_id, || async {
                channels.notify(&challenge_id, "expired")?;
                Ok("active")
            })
            .await?;

        // Assert
        assert_eq!(snapshot, "active");
        assert_eq!(receiver.try_recv(), Ok("expired"));
        Ok(())
    }

    #[tokio::test]
    async fn failed_snapshot_read_leaves_no_channel_behind() -> Result<(), Box<dyn Error>> {
        // Arrange
        let channels = ChallengeChannels::<&'static str>::new();
        let challenge_id = challenge_id()?;

        // Act
        let result = channels
            .subscribe_then_read(&challenge_id, || async {
                Err::<(), _>(AuthorityApplicationError::UnknownChallenge)
            })
            .await;

        // Assert
        assert!(matches!(
            result,
            Err(AuthorityApplicationError::UnknownChallenge)
        ));
        assert!(!channels.has_channel(&challenge_id));
        Ok(())
    }

    #[tokio::test]
    async fn failed_snapshot_read_keeps_the_channel_of_an_open_stream() -> Result<(), Box<dyn Error>>
    {
        // Arrange
        let channels = ChallengeChannels::<&'static str>::new();
        let challenge_id = challenge_id()?;
        let (_snapshot, mut open_stream) = channels
            .subscribe_then_read(&challenge_id, || async { Ok("active") })
            .await?;
        let failed = channels
            .subscribe_then_read(&challenge_id, || async {
                Err::<(), _>(AuthorityApplicationError::UnknownChallenge)
            })
            .await;

        // Act
        channels.notify(&challenge_id, "paused")?;

        // Assert
        assert!(failed.is_err());
        assert_eq!(open_stream.try_recv(), Ok("paused"));
        Ok(())
    }
}
