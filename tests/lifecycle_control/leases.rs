use super::*;

#[tokio::test]
async fn healthy_renewal_extends_one_lease_but_clock_failures_stop_it() -> Result<(), Box<dyn Error>>
{
    // Arrange
    let fixture = LifecycleFixture::start().await?;
    let challenge_id = fixture.create_challenge("action_renew_01").await?;
    let session_id = WorkSessionId::try_from("session_renew_01".to_owned())?;
    fixture
        .adapter
        .register_session(&challenge_id, session_id.clone())
        .await?;
    let lease = fixture
        .adapter
        .start_lease(&session_id, WorkerClock::new("boot_renew_01", 10_000)?)
        .await?;

    // Act
    let renewed = fixture
        .adapter
        .renew_lease(
            &session_id,
            lease.lease_id(),
            WorkerClock::new("boot_renew_01", 20_000)?,
        )
        .await?;
    let expired = fixture
        .adapter
        .renew_lease(
            &session_id,
            lease.lease_id(),
            WorkerClock::new("boot_renew_01", renewed.expires_at_monotonic_milliseconds())?,
        )
        .await;
    let stopped = fixture.adapter.session_lifecycle(&session_id).await?;

    // Assert
    assert_eq!(renewed.lease_id(), lease.lease_id());
    assert_eq!(renewed.renew_at_monotonic_milliseconds(), 40_000);
    assert_eq!(renewed.expires_at_monotonic_milliseconds(), 80_000);
    assert!(matches!(
        expired,
        Err(AuthorityApplicationError::WorkLeaseExpired)
    ));
    assert_eq!(stopped.state(), SessionLifecycleState::Stopping);
    assert_eq!(stopped.maybe_stop_reason(), Some("lease_expired"));

    Ok(())
}

#[tokio::test]
async fn changed_boot_or_decreased_monotonic_time_cannot_renew_a_lease()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let fixture = LifecycleFixture::start().await?;
    for (suffix, renewal_clock, expected_reason) in [
        (
            "boot",
            WorkerClock::new("different_boot", 20_000)?,
            "worker_reboot",
        ),
        (
            "monotonic",
            WorkerClock::new("stable_boot", 9_000)?,
            "monotonic_reset",
        ),
    ] {
        let challenge_id = fixture
            .create_challenge(&format!("action_renew_{suffix}"))
            .await?;
        let session_id = WorkSessionId::try_from(format!("session_renew_{suffix}"))?;
        fixture
            .adapter
            .register_session(&challenge_id, session_id.clone())
            .await?;
        let initial_continuity = if suffix == "boot" {
            "original_boot"
        } else {
            "stable_boot"
        };
        let lease = fixture
            .adapter
            .start_lease(&session_id, WorkerClock::new(initial_continuity, 10_000)?)
            .await?;

        // Act
        let result = fixture
            .adapter
            .renew_lease(&session_id, lease.lease_id(), renewal_clock)
            .await;
        let stopped = fixture.adapter.session_lifecycle(&session_id).await?;

        // Assert
        assert!(matches!(
            result,
            Err(AuthorityApplicationError::WorkerContinuityLost)
        ));
        assert_eq!(stopped.state(), SessionLifecycleState::Stopping);
        assert_eq!(stopped.maybe_stop_reason(), Some(expected_reason));
    }

    Ok(())
}

#[tokio::test]
async fn failed_session_is_observable_and_cannot_be_released() -> Result<(), Box<dyn Error>> {
    // Arrange
    let fixture = LifecycleFixture::start().await?;
    let challenge_id = fixture.create_challenge("action_failed_session_01").await?;
    let session_id = WorkSessionId::try_from("session_failed_01".to_owned())?;
    fixture
        .adapter
        .register_session(&challenge_id, session_id.clone())
        .await?;

    // Act
    fixture.adapter.fail_session(&session_id).await?;
    fixture.adapter.fail_session(&session_id).await?;
    let lifecycle = fixture.adapter.session_lifecycle(&session_id).await?;
    let lease = fixture
        .adapter
        .start_lease(&session_id, WorkerClock::new("boot_failed_01", 1_000)?)
        .await;
    // Assert
    assert_eq!(lifecycle.state(), SessionLifecycleState::Failed);
    assert_eq!(lifecycle.maybe_stop_reason(), Some("session_failed"));
    assert!(matches!(
        lease,
        Err(AuthorityApplicationError::ForbiddenLifecycleTransition)
    ));

    Ok(())
}

#[tokio::test]
async fn lost_worker_time_continuity_terminates_instead_of_renewing() -> Result<(), Box<dyn Error>>
{
    // Arrange
    let fixture = LifecycleFixture::start().await?;
    let cases = [
        ("reboot", WorkerInterruption::Reboot),
        ("reset", WorkerInterruption::MonotonicReset),
        ("uncertain", WorkerInterruption::UncertainTime),
    ];

    for (suffix, interruption) in cases {
        let challenge_id = fixture
            .create_challenge(&format!("action_continuity_{suffix}"))
            .await?;
        let session_id = WorkSessionId::try_from(format!("session_continuity_{suffix}"))?;
        fixture
            .adapter
            .register_session(&challenge_id, session_id.clone())
            .await?;
        fixture
            .adapter
            .start_lease(
                &session_id,
                WorkerClock::new(format!("boot_{suffix}"), 10_000)?,
            )
            .await?;

        // Act
        fixture.adapter.interrupt(&session_id, interruption).await?;
        let lifecycle = fixture.adapter.session_lifecycle(&session_id).await?;

        // Assert
        assert_eq!(lifecycle.state(), SessionLifecycleState::Stopping);
        assert_eq!(lifecycle.maybe_stop_reason(), Some(interruption.as_str()));
        assert!(lifecycle.maybe_lease().is_none());
    }

    Ok(())
}

#[tokio::test]
async fn report_at_lease_expiry_stops_new_work_but_exact_replay_stays_stable()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let fixture = LifecycleFixture::start().await?;
    let challenge_id = fixture.create_challenge("action_report_expiry_01").await?;
    let session_id = WorkSessionId::try_from("session_report_expiry_01".to_owned())?;
    fixture
        .adapter
        .register_session(&challenge_id, session_id.clone())
        .await?;
    let lease = fixture
        .adapter
        .start_lease(
            &session_id,
            WorkerClock::new("boot_report_expiry_01", 1_000)?,
        )
        .await?;
    let accepted_event = work_event(
        "event_before_lease_expiry_01",
        "share_before_lease_expiry_01",
        session_id.clone(),
        difficulty_one_target(),
    )?;
    let accepted = fixture
        .adapter
        .report(
            accepted_event.clone(),
            &lease,
            WorkerClock::new("boot_report_expiry_01", 2_000)?,
        )
        .await?;
    let late_event = work_event(
        "event_at_lease_expiry_01",
        "share_at_lease_expiry_01",
        session_id.clone(),
        difficulty_one_target(),
    )?;

    // Act
    let late = fixture
        .adapter
        .report(
            late_event,
            &lease,
            WorkerClock::new(
                "boot_report_expiry_01",
                lease.expires_at_monotonic_milliseconds(),
            )?,
        )
        .await;
    let replayed = fixture
        .adapter
        .report(
            accepted_event,
            &lease,
            WorkerClock::new("different_after_expiry", u64::MAX)?,
        )
        .await?;
    let stopped = fixture.adapter.session_lifecycle(&session_id).await?;

    // Assert
    assert!(matches!(
        late,
        Err(AuthorityApplicationError::WorkLeaseExpired)
    ));
    assert_eq!(replayed, accepted);
    assert_eq!(stopped.state(), SessionLifecycleState::Stopping);
    assert_eq!(stopped.maybe_stop_reason(), Some("lease_expired"));

    Ok(())
}
