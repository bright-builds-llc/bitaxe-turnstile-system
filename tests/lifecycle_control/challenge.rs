use super::*;

#[tokio::test]
async fn pause_preserves_progress_and_requires_restoration_before_resume()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let fixture = LifecycleFixture::start().await?;
    let challenge_id = fixture.create_challenge("action_pause_01").await?;
    let session_id = WorkSessionId::try_from("session_pause_01".to_owned())?;
    fixture
        .adapter
        .register_session(&challenge_id, session_id.clone())
        .await?;
    let first_lease = fixture
        .adapter
        .start_lease(&session_id, WorkerClock::new("boot_pause_01", 1_000)?)
        .await?;
    let progress = fixture
        .adapter
        .report(
            work_event(
                "event_pause_01",
                "share_pause_01",
                session_id.clone(),
                difficulty_one_target(),
            )?,
            &first_lease,
            WorkerClock::new("boot_pause_01", 1_100)?,
        )
        .await?;

    // Act
    let paused = fixture
        .pause(&challenge_id, PauseReason::UserRequested)
        .await?;
    let restarted = AuthorityApplication::connect_postgres(
        authority_config()?,
        fixture._database.database_url(),
    )
    .await?;
    let restarted_adapter = restarted.simulated_pool_adapter();
    let stopping = restarted_adapter.session_lifecycle(&session_id).await?;
    let blocked_resume = restarted_adapter
        .start_lease(&session_id, WorkerClock::new("boot_pause_01", 2_000)?)
        .await;
    restarted_adapter.confirm_restored(&session_id).await?;
    let resumed = restarted_adapter
        .start_lease(&session_id, WorkerClock::new("boot_pause_01", 3_000)?)
        .await?;

    // Assert
    assert_eq!(paused["state"], "active");
    assert_eq!(paused["authorization_eligible"], true);
    assert_eq!(
        paused["verified_progress"],
        progress.verified_progress().to_decimal_string()
    );
    assert_eq!(stopping.state(), SessionLifecycleState::Stopping);
    assert_eq!(stopping.maybe_stop_reason(), Some("user_requested"));
    assert!(blocked_resume.is_err());
    assert_ne!(resumed.lease_id(), first_lease.lease_id());

    Ok(())
}

#[tokio::test]
async fn tab_closure_and_connectivity_loss_have_pause_semantics() -> Result<(), Box<dyn Error>> {
    // Arrange
    let fixture = LifecycleFixture::start().await?;

    for (suffix, reason) in [
        ("tab", PauseReason::TabClosed),
        ("network", PauseReason::ConnectivityLost),
    ] {
        let challenge_id = fixture
            .create_challenge(&format!("action_pause_{suffix}"))
            .await?;
        let session_id = WorkSessionId::try_from(format!("session_pause_{suffix}"))?;
        fixture
            .adapter
            .register_session(&challenge_id, session_id.clone())
            .await?;
        fixture
            .adapter
            .start_lease(
                &session_id,
                WorkerClock::new(format!("boot_{suffix}"), 1_000)?,
            )
            .await?;

        // Act
        let lifecycle = fixture.pause(&challenge_id, reason).await?;
        let session = fixture.adapter.session_lifecycle(&session_id).await?;

        // Assert
        assert_eq!(lifecycle["state"], "active");
        assert_eq!(session.state(), SessionLifecycleState::Stopping);
        assert_eq!(session.maybe_stop_reason(), Some(reason.as_str()));
    }

    Ok(())
}

#[tokio::test]
async fn cancel_requires_destructive_confirmation_and_is_terminal() -> Result<(), Box<dyn Error>> {
    // Arrange
    let fixture = LifecycleFixture::start().await?;
    let challenge_id = fixture.create_challenge("action_cancel_01").await?;
    let session_id = WorkSessionId::try_from("session_cancel_01".to_owned())?;
    fixture
        .adapter
        .register_session(&challenge_id, session_id.clone())
        .await?;
    let lease = fixture
        .adapter
        .start_lease(&session_id, WorkerClock::new("boot_cancel_01", 1_000)?)
        .await?;
    let progress = fixture
        .adapter
        .report(
            work_event(
                "event_cancel_01",
                "share_cancel_01",
                session_id.clone(),
                difficulty_one_target(),
            )?,
            &lease,
            WorkerClock::new("boot_cancel_01", 1_100)?,
        )
        .await?;

    // Act
    let unconfirmed = fixture.cancel(&challenge_id, false).await?;
    let cancelled = fixture.cancel(&challenge_id, true).await?;
    let repeated = fixture.cancel(&challenge_id, true).await?;
    let forbidden_pause = reqwest::Client::new()
        .post(format!(
            "{}/v0/challenges/{}/pause",
            fixture.authority_url,
            challenge_id.as_str()
        ))
        .header(CLIENT_ID_HEADER, CLIENT_ID)
        .bearer_auth(SERVICE_SECRET)
        .json(&json!({ "reason": "user_requested" }))
        .send()
        .await?;
    let forbidden_resume = fixture
        .adapter
        .start_lease(&session_id, WorkerClock::new("boot_cancel_01", 2_000)?)
        .await;
    let forbidden_registration = fixture
        .adapter
        .register_session(
            &challenge_id,
            WorkSessionId::try_from("session_cancel_after_01".to_owned())?,
        )
        .await;
    let rejected_work = fixture
        .adapter
        .report(
            work_event(
                "event_cancel_after_01",
                "share_cancel_after_01",
                session_id,
                difficulty_one_target(),
            )?,
            &lease,
            WorkerClock::new("boot_cancel_01", 1_200)?,
        )
        .await;

    // Assert
    assert_eq!(unconfirmed.status().as_u16(), 400);
    assert_eq!(cancelled.status().as_u16(), 200);
    assert_eq!(repeated.status().as_u16(), 200);
    assert_eq!(forbidden_pause.status().as_u16(), 409);
    let cancelled_body = cancelled.json::<Value>().await?;
    assert_eq!(cancelled_body["state"], "cancelled");
    assert_eq!(cancelled_body["authorization_eligible"], false);
    assert_eq!(
        cancelled_body["verified_progress"],
        progress.verified_progress().to_decimal_string()
    );
    assert!(forbidden_resume.is_err());
    assert!(matches!(
        forbidden_registration,
        Err(AuthorityApplicationError::ForbiddenLifecycleTransition)
    ));
    assert!(matches!(
        rejected_work,
        Err(AuthorityApplicationError::ForbiddenLifecycleTransition)
    ));

    Ok(())
}

#[tokio::test]
async fn lifecycle_commands_require_the_existing_service_credential() -> Result<(), Box<dyn Error>>
{
    // Arrange
    let fixture = LifecycleFixture::start().await?;
    let challenge_id = fixture.create_challenge("action_lifecycle_auth_01").await?;

    // Act
    let pause = reqwest::Client::new()
        .post(format!(
            "{}/v0/challenges/{}/pause",
            fixture.authority_url,
            challenge_id.as_str()
        ))
        .json(&json!({ "reason": "user_requested" }))
        .send()
        .await?;
    let cancel = reqwest::Client::new()
        .post(format!(
            "{}/v0/challenges/{}/cancel",
            fixture.authority_url,
            challenge_id.as_str()
        ))
        .json(&json!({ "confirm_progress_loss": true }))
        .send()
        .await?;
    let wrong_controller = reqwest::Client::new()
        .post(format!(
            "{}/v0/challenges/{}/pause",
            fixture.authority_url,
            challenge_id.as_str()
        ))
        .header(CLIENT_ID_HEADER, OTHER_CLIENT_ID)
        .bearer_auth(OTHER_SERVICE_SECRET)
        .json(&json!({ "reason": "user_requested" }))
        .send()
        .await?;
    let snapshot = fixture.lifecycle(&challenge_id).await?;

    // Assert
    assert_eq!(pause.status().as_u16(), 401);
    assert_eq!(cancel.status().as_u16(), 401);
    assert_eq!(wrong_controller.status().as_u16(), 403);
    assert_eq!(snapshot["state"], "issued");

    Ok(())
}

#[tokio::test]
async fn lifecycle_sse_emits_typed_initial_and_control_updates() -> Result<(), Box<dyn Error>> {
    // Arrange
    let fixture = LifecycleFixture::start().await?;
    let challenge_id = fixture.create_challenge("action_lifecycle_sse_01").await?;
    let mut stream = reqwest::get(format!(
        "{}/v0/challenges/{}/events",
        fixture.authority_url,
        challenge_id.as_str()
    ))
    .await?;
    let issued = read_sse_until(&mut stream, "\"state\":\"issued\"").await?;
    let session_id = WorkSessionId::try_from("session_lifecycle_sse_01".to_owned())?;
    fixture
        .adapter
        .register_session(&challenge_id, session_id.clone())
        .await?;

    // Act
    fixture
        .adapter
        .start_lease(
            &session_id,
            WorkerClock::new("boot_lifecycle_sse_01", 1_000)?,
        )
        .await?;
    let active = read_sse_until(&mut stream, "\"state\":\"active\"").await?;
    fixture
        .pause(&challenge_id, PauseReason::ConnectivityLost)
        .await?;
    let paused = read_sse_until(&mut stream, "\"state\":\"active\"").await?;

    // Assert
    for event in [issued, active, paused] {
        assert!(event.contains("event: challenge_lifecycle"));
    }

    Ok(())
}

#[tokio::test]
async fn connected_lifecycle_sse_emits_expiry_at_the_absolute_deadline()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let fixture = LifecycleFixture::start().await?;
    let challenge_id = fixture
        .create_challenge("action_lifecycle_sse_expiry_01")
        .await?;
    let session_id = WorkSessionId::try_from("session_lifecycle_sse_expiry_01".to_owned())?;
    fixture
        .adapter
        .register_session(&challenge_id, session_id.clone())
        .await?;
    fixture
        .adapter
        .start_lease(
            &session_id,
            WorkerClock::new("boot_lifecycle_sse_expiry_01", 1_000)?,
        )
        .await?;
    let deadline = current_unix_seconds()? + 1;
    let pool = sqlx::PgPool::connect(fixture._database.database_url()).await?;
    sqlx::query(
        "UPDATE gate_authority.work_challenges
         SET expires_at_unix_seconds = $2, terminal_at_unix_seconds = $2
         WHERE challenge_id = $1",
    )
    .bind(challenge_id.as_str())
    .bind(i64::try_from(deadline)?)
    .execute(&pool)
    .await?;
    let mut stream = reqwest::get(format!(
        "{}/v0/challenges/{}/events",
        fixture.authority_url,
        challenge_id.as_str()
    ))
    .await?;
    let active = read_sse_until(&mut stream, "\"state\":\"active\"").await?;
    let mut second_stream = reqwest::get(format!(
        "{}/v0/challenges/{}/events",
        fixture.authority_url,
        challenge_id.as_str()
    ))
    .await?;
    read_sse_until(&mut second_stream, "\"state\":\"active\"").await?;

    // Act
    let expired = read_sse_until(&mut stream, "\"state\":\"expired\"").await?;
    let second_expired = read_sse_until(&mut second_stream, "\"state\":\"expired\"").await?;

    // Assert
    assert!(active.contains("event: challenge_lifecycle"));
    assert!(expired.contains("event: challenge_lifecycle"));
    assert!(expired.contains("\"authorization_eligible\":false"));
    assert_eq!(expired.matches("\"state\":\"expired\"").count(), 1);
    assert_eq!(second_expired.matches("\"state\":\"expired\"").count(), 1);

    Ok(())
}

#[tokio::test]
async fn all_challenge_states_are_visible_through_the_public_snapshot() -> Result<(), Box<dyn Error>>
{
    // Arrange
    let fixture = LifecycleFixture::start().await?;
    let challenge_id = fixture.create_challenge("action_all_states_01").await?;
    let issued = fixture.lifecycle(&challenge_id).await?;
    let session_id = WorkSessionId::try_from("session_all_states_01".to_owned())?;
    fixture
        .adapter
        .register_session(&challenge_id, session_id.clone())
        .await?;
    let ready = fixture.adapter.session_lifecycle(&session_id).await?;

    // Act
    let lease = fixture
        .adapter
        .start_lease(&session_id, WorkerClock::new("boot_all_states_01", 1_000)?)
        .await?;
    let active = fixture.lifecycle(&challenge_id).await?;
    fixture
        .adapter
        .report(
            work_event(
                "event_all_states_01",
                "share_all_states_01",
                session_id,
                light_threshold_target(),
            )?,
            &lease,
            WorkerClock::new("boot_all_states_01", 1_100)?,
        )
        .await?;
    let satisfied = fixture.lifecycle(&challenge_id).await?;
    fixture
        .application
        .process_next_issuance(
            &IssuanceWorkerId::try_from("worker_all_states_01".to_owned())?,
            current_unix_seconds()?,
        )
        .await?;
    let pass_issued = fixture.lifecycle(&challenge_id).await?;

    // Assert
    assert_eq!(issued["state"], "issued");
    assert_eq!(ready.state(), SessionLifecycleState::Ready);
    assert_eq!(active["state"], "active");
    assert_eq!(satisfied["state"], "satisfied");
    assert_eq!(pass_issued["state"], "pass_issued");

    Ok(())
}

#[tokio::test]
async fn challenge_expiry_ends_leases_and_makes_progress_ineligible() -> Result<(), Box<dyn Error>>
{
    // Arrange
    let fixture = LifecycleFixture::start().await?;
    let challenge_id = fixture.create_challenge("action_expiry_01").await?;
    let session_id = WorkSessionId::try_from("session_expiry_01".to_owned())?;
    fixture
        .adapter
        .register_session(&challenge_id, session_id.clone())
        .await?;
    let lease = fixture
        .adapter
        .start_lease(&session_id, WorkerClock::new("boot_expiry_01", 1_000)?)
        .await?;
    let now = current_unix_seconds()?;
    sqlx::query(
        "UPDATE gate_authority.work_challenges
         SET expires_at_unix_seconds = $2, terminal_at_unix_seconds = $2
         WHERE challenge_id = $1",
    )
    .bind(challenge_id.as_str())
    .bind(i64::try_from(now - 1)?)
    .execute(&sqlx::PgPool::connect(fixture._database.database_url()).await?)
    .await?;

    // Act
    let blocked_restart = fixture
        .adapter
        .start_lease(&session_id, WorkerClock::new("boot_expiry_01", 2_000)?)
        .await;
    let expired = fixture.lifecycle(&challenge_id).await?;
    let stopped = fixture.adapter.session_lifecycle(&session_id).await?;
    let late_work = fixture
        .adapter
        .report(
            work_event(
                "event_expiry_01",
                "share_expiry_01",
                session_id,
                difficulty_one_target(),
            )?,
            &lease,
            WorkerClock::new("boot_expiry_01", 1_100)?,
        )
        .await;

    // Assert
    assert_eq!(expired["state"], "expired");
    assert_eq!(expired["authorization_eligible"], false);
    assert_eq!(stopped.state(), SessionLifecycleState::Stopping);
    assert_eq!(stopped.maybe_stop_reason(), Some("challenge_expired"));
    assert!(matches!(
        blocked_restart,
        Err(AuthorityApplicationError::ForbiddenLifecycleTransition)
    ));
    assert!(matches!(
        late_work,
        Err(AuthorityApplicationError::ForbiddenLifecycleTransition)
    ));

    Ok(())
}

async fn read_sse_until(
    response: &mut reqwest::Response,
    needle: &str,
) -> Result<String, Box<dyn Error>> {
    tokio::time::timeout(Duration::from_secs(2), async {
        let mut received = String::new();
        loop {
            let chunk = response
                .chunk()
                .await?
                .ok_or("SSE stream ended before the expected lifecycle event")?;
            received.push_str(&String::from_utf8(chunk.to_vec())?);
            if received.contains(needle) {
                return Ok::<String, Box<dyn Error>>(received);
            }
        }
    })
    .await?
}
