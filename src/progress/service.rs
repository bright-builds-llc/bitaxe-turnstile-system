use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use tokio::sync::broadcast;

use super::{
    AcceptedEventRecord, AcceptedWorkAcknowledgement, AcceptedWorkEvent, AcceptedWorkEventId,
    ChallengeId, ChallengeProgress, CreditedWork, ProgressError, ProgressUpdate, ShareFingerprint,
    WorkSessionId,
};

const PROGRESS_CHANNEL_CAPACITY: usize = 32;

/// In-memory application module retained for pure unit tests.
#[derive(Clone, Default)]
pub struct ProgressService {
    state: Arc<Mutex<ProgressServiceState>>,
}

#[derive(Default)]
struct ProgressServiceState {
    challenges: HashMap<ChallengeId, ChallengeChannel>,
    work_sessions: HashMap<WorkSessionId, ChallengeId>,
    events: HashMap<AcceptedWorkEventId, GlobalEventRecord>,
    share_fingerprints: HashMap<ShareFingerprint, ChallengeId>,
}

struct GlobalEventRecord {
    challenge_id: ChallengeId,
    accepted_event: AcceptedEventRecord,
}

struct ChallengeChannel {
    progress: ChallengeProgress,
    updates: broadcast::Sender<ProgressUpdate>,
}

impl ProgressService {
    /// Resolves the challenge canonically bound to one registered Work Session.
    pub fn challenge_for_session(
        &self,
        session_id: &WorkSessionId,
    ) -> Result<ChallengeId, ProgressError> {
        self.lock_state()?
            .work_sessions
            .get(session_id)
            .cloned()
            .ok_or(ProgressError::UnknownWorkSession)
    }

    /// Registers an immutable issued challenge before accepting Work Sessions.
    pub fn register_challenge(
        &self,
        challenge_id: ChallengeId,
        work_requirement: CreditedWork,
    ) -> Result<(), ProgressError> {
        let mut state = self.lock_state()?;
        if state.challenges.contains_key(&challenge_id) {
            return Err(ProgressError::DuplicateChallenge);
        }
        let (updates, _receiver) = broadcast::channel(PROGRESS_CHANNEL_CAPACITY);
        state.challenges.insert(
            challenge_id,
            ChallengeChannel {
                progress: ChallengeProgress::new(work_requirement),
                updates,
            },
        );
        Ok(())
    }

    /// Binds one opaque Work Session to exactly one registered challenge.
    pub fn register_session(
        &self,
        challenge_id: &ChallengeId,
        session_id: WorkSessionId,
    ) -> Result<(), ProgressError> {
        let mut state = self.lock_state()?;
        if state.work_sessions.contains_key(&session_id) {
            return Err(ProgressError::DuplicateWorkSession);
        }
        let maybe_channel = state.challenges.get_mut(challenge_id);
        let Some(channel) = maybe_channel else {
            return Err(ProgressError::UnknownChallenge);
        };
        channel.progress.register_session(session_id.clone())?;
        state.work_sessions.insert(session_id, challenge_id.clone());
        Ok(())
    }

    /// Applies one event and returns its stable replay acknowledgement.
    pub fn report(
        &self,
        event: AcceptedWorkEvent,
    ) -> Result<AcceptedWorkAcknowledgement, ProgressError> {
        let mut state = self.lock_state()?;
        let maybe_challenge_id = state.work_sessions.get(&event.work_session_id).cloned();
        let Some(challenge_id) = maybe_challenge_id else {
            return Err(ProgressError::UnknownWorkSession);
        };
        if let Some(record) = state.events.get(&event.event_id) {
            if record.challenge_id != challenge_id {
                return Err(ProgressError::ConflictingEventReplay);
            }
            return record.accepted_event.replay_acknowledgement(&event);
        }

        let event_id = event.event_id.clone();
        let share_fingerprint = event.share_fingerprint.clone();
        let recorded_event = event.clone();
        let globally_duplicate_share = state.share_fingerprints.contains_key(&share_fingerprint);
        let (acknowledgement, maybe_notification) = {
            let channel = state
                .challenges
                .get_mut(&challenge_id)
                .ok_or(ProgressError::UnknownChallenge)?;
            let progress_before = channel.progress.verified_progress();
            let acknowledgement = channel
                .progress
                .accept_with_global_duplicate(event, globally_duplicate_share)?;
            let maybe_notification = (channel.progress.verified_progress() != progress_before)
                .then(|| {
                    (
                        channel.updates.clone(),
                        channel.progress.update(challenge_id.clone()),
                    )
                });
            (acknowledgement, maybe_notification)
        };
        state
            .share_fingerprints
            .entry(share_fingerprint)
            .or_insert_with(|| challenge_id.clone());
        state.events.insert(
            event_id,
            GlobalEventRecord {
                challenge_id,
                accepted_event: AcceptedEventRecord::new(recorded_event, acknowledgement.clone()),
            },
        );
        drop(state);
        if let Some((updates, update)) = maybe_notification
            && updates.receiver_count() > 0
            && let Err(error) = updates.send(update)
        {
            tracing::debug!(%error, "progress subscriber disconnected before notification");
        }
        Ok(acknowledgement)
    }

    /// Returns a current snapshot and receiver for subsequent updates.
    pub fn subscribe(
        &self,
        challenge_id: &ChallengeId,
    ) -> Result<(ProgressUpdate, broadcast::Receiver<ProgressUpdate>), ProgressError> {
        let state = self.lock_state()?;
        let channel = state
            .challenges
            .get(challenge_id)
            .ok_or(ProgressError::UnknownChallenge)?;
        Ok((
            channel.progress.update(challenge_id.clone()),
            channel.updates.subscribe(),
        ))
    }

    fn lock_state(&self) -> Result<std::sync::MutexGuard<'_, ProgressServiceState>, ProgressError> {
        self.state
            .lock()
            .map_err(|_| ProgressError::ProgressStateUnavailable)
    }
}
