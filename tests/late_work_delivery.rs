//! The Authority judges a Work Event by the reading at which it was observed (Ticket 11).

use std::{
    error::Error,
    time::{SystemTime, UNIX_EPOCH},
};

use bwg_core::{
    authority::AuthorityApplicationError,
    progress::{AcceptedWorkAcknowledgement, AcceptedWorkRefusal},
    stratum_v1::StratumLeaseContext,
};
use reqwest::StatusCode;
use serde_json::Value;

#[path = "support/authority_keys.rs"]
mod authority_key_support;
#[path = "support/claimant.rs"]
mod claimant_support;
#[path = "support/claimant_work_session.rs"]
mod fixture;
#[path = "support/postgres.rs"]
mod postgres_support;
#[allow(dead_code)]
#[path = "support/running_server.rs"]
mod running_server;
#[allow(dead_code)]
#[path = "support/work_session.rs"]
mod work_session_support;
use fixture::{CONTROL_SESSION, Fixture, OTHER_CONTROL_SESSION, claimant_session_id};
use work_session_support::accepted_event;

/// The smallest test target credit, so two events never satisfy the challenge.
const LOW_WORK_TARGET_MARKER: u8 = 0xff;
/// A test target whose one share satisfies the challenge.
const SATISFYING_TARGET_MARKER: u8 = 0x01;

type Delivery = Result<AcceptedWorkAcknowledgement, AuthorityApplicationError>;

struct Leased {
    fixture: Fixture,
    grant: Value,
}

impl Leased {
    async fn start() -> Result<Self, Box<dyn Error>> {
        let fixture = Fixture::start().await?;
        let grant = fixture.start_work().await?;
        Ok(Self { fixture, grant })
    }

    fn lease_id(&self) -> Result<&str, Box<dyn Error>> {
        Ok(self.grant["leaseId"].as_str().ok_or("lease ID")?)
    }

    /// Delivers one event the Pool Adapter observed at `reading` under `continuity`.
    async fn deliver(
        &self,
        name: &str,
        share: &str,
        continuity: &str,
        reading: u64,
    ) -> Result<Delivery, Box<dyn Error>> {
        self.deliver_as(name, share, continuity, reading, LOW_WORK_TARGET_MARKER)
            .await
    }

    async fn deliver_with_target(
        &self,
        name: &str,
        share: &str,
        reading: u64,
        target_marker: u8,
    ) -> Result<Delivery, Box<dyn Error>> {
        self.deliver_as(name, share, CONTROL_SESSION, reading, target_marker)
            .await
    }

    async fn deliver_as(
        &self,
        name: &str,
        share: &str,
        continuity: &str,
        reading: u64,
        target_marker: u8,
    ) -> Result<Delivery, Box<dyn Error>> {
        let context = StratumLeaseContext::new(
            self.lease_id()?.to_owned(),
            continuity.to_owned(),
            reading,
            reading + 20_000,
            reading + 60_000,
        )?;
        let event = accepted_event(
            &format!("event_{name}"),
            &format!("share_{share}"),
            claimant_session_id(&self.fixture.challenge_id)?,
            target_marker,
            reading / 1_000,
        )?;
        Ok(self
            .fixture
            .application
            .simulated_pool_adapter()
            .report_stratum(event, &context)
            .await)
    }

    async fn verified_progress(&self) -> Result<String, Box<dyn Error>> {
        let pool = sqlx::PgPool::connect(self.fixture.database.database_url()).await?;
        Ok(sqlx::query_scalar(
            "SELECT verified_progress::text FROM gate_authority.work_challenges WHERE challenge_id = $1",
        )
        .bind(self.fixture.challenge_id.as_str())
        .fetch_one(&pool)
        .await?)
    }

    /// Moves the challenge deadline to `deadline_unix_seconds`.
    async fn set_challenge_deadline(
        &self,
        deadline_unix_seconds: u64,
    ) -> Result<(), Box<dyn Error>> {
        let pool = sqlx::PgPool::connect(self.fixture.database.database_url()).await?;
        let past = i64::try_from(deadline_unix_seconds)?;
        sqlx::query(
            "UPDATE gate_authority.work_challenges
             SET expires_at_unix_seconds = $2, terminal_at_unix_seconds = $2
             WHERE challenge_id = $1",
        )
        .bind(self.fixture.challenge_id.as_str())
        .bind(past)
        .execute(&pool)
        .await?;
        Ok(())
    }

    /// Reads the lifecycle snapshot, which records an arrived deadline.
    async fn lifecycle_state(&self) -> Result<String, Box<dyn Error>> {
        let snapshot: Value = reqwest::get(format!(
            "{}/v0/challenges/{}/lifecycle",
            self.fixture.server.base_url,
            self.fixture.challenge_id.as_str()
        ))
        .await?
        .error_for_status()?
        .json()
        .await?;
        Ok(snapshot["state"]
            .as_str()
            .ok_or("lifecycle state")?
            .to_owned())
    }

    async fn renew(&self) -> Result<StatusCode, Box<dyn Error>> {
        Ok(self
            .fixture
            .renew(&self.grant["leaseId"], CONTROL_SESSION)
            .await?
            .status())
    }
}

fn now_unix_milliseconds() -> Result<u64, Box<dyn Error>> {
    Ok(u64::try_from(
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis(),
    )?)
}

#[tokio::test]
async fn share_observed_before_a_renew_is_credited_when_delivered_after_it()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let leased = Leased::start().await?;
    let observed_at = now_unix_milliseconds()?;
    assert_eq!(leased.renew().await?, StatusCode::OK);

    // Act
    let delivered = leased
        .deliver("late_01", "late_01", CONTROL_SESSION, observed_at)
        .await??;

    // Assert
    assert!(delivered.maybe_credited_work().is_some());
    assert_eq!(leased.renew().await?, StatusCode::OK);
    Ok(())
}

#[tokio::test]
async fn share_observed_after_the_renewal_hint_is_credited() -> Result<(), Box<dyn Error>> {
    // Arrange
    let leased = Leased::start().await?;
    let past_the_hint = now_unix_milliseconds()? + 20_500;

    // Act
    let delivered = leased
        .deliver("hint_01", "hint_01", CONTROL_SESSION, past_the_hint)
        .await??;

    // Assert
    assert!(delivered.maybe_credited_work().is_some());
    Ok(())
}

#[tokio::test]
async fn reading_before_the_lease_started_is_refused() -> Result<(), Box<dyn Error>> {
    // Arrange
    let leased = Leased::start().await?;
    let before_start = now_unix_milliseconds()? - 10_000;

    // Act
    let delivered = leased
        .deliver("before_01", "before_01", CONTROL_SESSION, before_start)
        .await?;

    // Assert
    assert!(matches!(
        delivered,
        Err(AuthorityApplicationError::WorkRefused(
            AcceptedWorkRefusal::WorkerContinuityLost
        ))
    ));
    assert_eq!(leased.renew().await?, StatusCode::CONFLICT);
    Ok(())
}

#[tokio::test]
async fn event_delivered_out_of_order_is_credited() -> Result<(), Box<dyn Error>> {
    // Arrange
    let leased = Leased::start().await?;
    let now = now_unix_milliseconds()?;
    leased
        .deliver("order_01", "order_01", CONTROL_SESSION, now + 5_000)
        .await??;

    // Act
    let delivered = leased
        .deliver("order_02", "order_02", CONTROL_SESSION, now + 4_000)
        .await??;

    // Assert
    assert!(delivered.maybe_credited_work().is_some());
    assert_eq!(leased.renew().await?, StatusCode::OK);
    Ok(())
}

#[tokio::test]
async fn reading_under_another_continuity_is_refused() -> Result<(), Box<dyn Error>> {
    // Arrange
    let leased = Leased::start().await?;
    let now = now_unix_milliseconds()?;

    // Act
    let delivered = leased
        .deliver("other_01", "other_01", OTHER_CONTROL_SESSION, now)
        .await?;

    // Assert
    assert!(matches!(
        delivered,
        Err(AuthorityApplicationError::WorkRefused(
            AcceptedWorkRefusal::WorkerContinuityLost
        ))
    ));
    Ok(())
}

#[tokio::test]
async fn replayed_event_and_duplicate_share_after_a_renew_earn_no_second_credit()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let leased = Leased::start().await?;
    let observed_at = now_unix_milliseconds()?;
    let first = leased
        .deliver("dup_01", "dup_01", CONTROL_SESSION, observed_at)
        .await??;
    assert_eq!(leased.renew().await?, StatusCode::OK);

    // Act
    let replayed = leased
        .deliver("dup_01", "dup_01", CONTROL_SESSION, observed_at)
        .await??;
    let duplicate_share = leased
        .deliver("dup_02", "dup_01", CONTROL_SESSION, observed_at + 1)
        .await??;

    // Assert
    assert_eq!(replayed, first);
    assert!(duplicate_share.maybe_credited_work().is_none());
    assert_eq!(
        duplicate_share.verified_progress(),
        first.verified_progress()
    );
    Ok(())
}

#[tokio::test]
async fn work_delivered_after_a_pause_is_not_credited() -> Result<(), Box<dyn Error>> {
    // Arrange
    let leased = Leased::start().await?;
    let observed_at = now_unix_milliseconds()?;
    leased.fixture.pause().await?;

    // Act
    let delivered = leased
        .deliver("paused_01", "paused_01", CONTROL_SESSION, observed_at)
        .await?;

    // Assert
    assert!(matches!(
        delivered,
        Err(AuthorityApplicationError::WorkRefused(
            AcceptedWorkRefusal::WorkLeaseEnded
        ))
    ));
    assert_eq!(leased.verified_progress().await?, "0");
    Ok(())
}

#[tokio::test]
async fn work_delivered_after_satisfaction_is_not_credited() -> Result<(), Box<dyn Error>> {
    // Arrange
    let leased = Leased::start().await?;
    let observed_at = now_unix_milliseconds()?;
    let satisfying = leased
        .deliver_with_target(
            "sat_01",
            "sat_01",
            observed_at + 1,
            SATISFYING_TARGET_MARKER,
        )
        .await??;
    assert!(satisfying.issuance_intent_created());
    let progress = leased.verified_progress().await?;

    // Act
    let late = leased
        .deliver("sat_02", "sat_02", CONTROL_SESSION, observed_at)
        .await?;
    let replayed = leased
        .deliver_with_target(
            "sat_01",
            "sat_01",
            observed_at + 1,
            SATISFYING_TARGET_MARKER,
        )
        .await??;

    // Assert
    assert!(matches!(
        late,
        Err(AuthorityApplicationError::WorkRefused(
            AcceptedWorkRefusal::ChallengeSatisfied
        ))
    ));
    assert_eq!(replayed, satisfying);
    assert_eq!(leased.verified_progress().await?, progress);
    Ok(())
}

#[tokio::test]
async fn work_delivered_after_the_deadline_is_refused_before_expiry_is_recorded()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let leased = Leased::start().await?;
    let observed_at = now_unix_milliseconds()?;
    let deadline = observed_at / 1_000 + 1;
    leased.set_challenge_deadline(deadline).await?;
    tokio::time::sleep(std::time::Duration::from_millis(
        (deadline * 1_000).saturating_sub(now_unix_milliseconds()?) + 50,
    ))
    .await;

    // Act
    let delivered = leased
        .deliver("deadline_01", "deadline_01", CONTROL_SESSION, observed_at)
        .await?;

    // Assert
    assert!(matches!(
        delivered,
        Err(AuthorityApplicationError::WorkRefused(
            AcceptedWorkRefusal::ChallengeDeadlinePassed
        ))
    ));
    assert_eq!(leased.verified_progress().await?, "0");
    assert_eq!(leased.lifecycle_state().await?, "expired");
    Ok(())
}

#[tokio::test]
async fn work_under_an_unknown_lease_is_refused() -> Result<(), Box<dyn Error>> {
    // Arrange
    let leased = Leased::start().await?;
    let now = now_unix_milliseconds()?;
    let context = StratumLeaseContext::new(
        "00000000-0000-4000-8000-000000000001".to_owned(),
        CONTROL_SESSION.to_owned(),
        now,
        now + 20_000,
        now + 60_000,
    )?;
    let event = accepted_event(
        "event_unknown_lease_01",
        "share_unknown_lease_01",
        claimant_session_id(&leased.fixture.challenge_id)?,
        LOW_WORK_TARGET_MARKER,
        now / 1_000,
    )?;

    // Act
    let delivered = leased
        .fixture
        .application
        .simulated_pool_adapter()
        .report_stratum(event, &context)
        .await;

    // Assert
    assert!(matches!(
        delivered,
        Err(AuthorityApplicationError::WorkRefused(
            AcceptedWorkRefusal::UnknownWorkLease
        ))
    ));
    assert_eq!(leased.renew().await?, StatusCode::OK);
    Ok(())
}

#[tokio::test]
async fn work_delivered_after_a_cancel_is_refused() -> Result<(), Box<dyn Error>> {
    // Arrange
    let leased = Leased::start().await?;
    let observed_at = now_unix_milliseconds()?;
    leased
        .fixture
        .post(
            "cancel",
            &serde_json::json!({ "confirm_progress_loss": true }),
        )
        .await?
        .error_for_status()?;

    // Act
    let delivered = leased
        .deliver("cancelled_01", "cancelled_01", CONTROL_SESSION, observed_at)
        .await?;

    // Assert
    assert!(matches!(
        delivered,
        Err(AuthorityApplicationError::WorkRefused(
            AcceptedWorkRefusal::ChallengeCancelled
        ))
    ));
    assert_eq!(leased.verified_progress().await?, "0");
    Ok(())
}

#[tokio::test]
async fn event_id_reused_with_another_share_is_refused() -> Result<(), Box<dyn Error>> {
    // Arrange
    let leased = Leased::start().await?;
    let observed_at = now_unix_milliseconds()?;
    let first = leased
        .deliver("reused_01", "reused_01", CONTROL_SESSION, observed_at)
        .await??;

    // Act
    let conflicting = leased
        .deliver("reused_01", "reused_02", CONTROL_SESSION, observed_at)
        .await?;

    // Assert
    assert!(matches!(
        conflicting,
        Err(AuthorityApplicationError::WorkRefused(
            AcceptedWorkRefusal::ConflictingEventReplay
        ))
    ));
    assert_eq!(
        leased.verified_progress().await?,
        first.verified_progress().to_decimal_string()
    );
    Ok(())
}

#[tokio::test]
async fn replay_after_the_deadline_returns_the_first_acknowledgement() -> Result<(), Box<dyn Error>>
{
    // Arrange
    let leased = Leased::start().await?;
    let observed_at = now_unix_milliseconds()?;
    let first = leased
        .deliver(
            "deadline_replay_01",
            "deadline_replay_01",
            CONTROL_SESSION,
            observed_at,
        )
        .await??;
    let deadline = observed_at / 1_000 + 1;
    leased.set_challenge_deadline(deadline).await?;
    tokio::time::sleep(std::time::Duration::from_millis(
        (deadline * 1_000).saturating_sub(now_unix_milliseconds()?) + 50,
    ))
    .await;

    // Act
    let replayed = leased
        .deliver(
            "deadline_replay_01",
            "deadline_replay_01",
            CONTROL_SESSION,
            observed_at,
        )
        .await??;

    // Assert
    assert_eq!(replayed, first);
    Ok(())
}
