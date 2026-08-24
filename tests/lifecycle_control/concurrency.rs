use super::*;

#[tokio::test]
async fn pause_winning_the_session_lock_prevents_later_work_admission() -> Result<(), Box<dyn Error>>
{
    // Arrange
    let fixture = LifecycleFixture::start().await?;
    let challenge_id = fixture.create_challenge("action_pause_race_01").await?;
    let session_id = WorkSessionId::try_from("session_pause_race_01".to_owned())?;
    fixture
        .adapter
        .register_session(&challenge_id, session_id.clone())
        .await?;
    let lease = fixture
        .adapter
        .start_lease(&session_id, WorkerClock::new("boot_pause_race_01", 1_000)?)
        .await?;
    let pool = sqlx::PgPool::connect(fixture._database.database_url()).await?;
    let mut blocker = pool.begin().await?;
    sqlx::query(
        "SELECT session_id FROM gate_authority.work_sessions
         WHERE session_id = $1 FOR UPDATE",
    )
    .bind("session_pause_race_01")
    .execute(&mut *blocker)
    .await?;
    let pause_url = format!(
        "{}/v0/challenges/{}/pause",
        fixture.authority_url,
        challenge_id.as_str()
    );
    let pause = tokio::spawn(async move {
        reqwest::Client::new()
            .post(pause_url)
            .header(CLIENT_ID_HEADER, CLIENT_ID)
            .bearer_auth(SERVICE_SECRET)
            .json(&json!({ "reason": "user_requested" }))
            .send()
            .await
    });
    wait_for_blocked_query(&pool, "%UPDATE gate_authority.work_sessions%").await?;
    let adapter = fixture.adapter.clone();
    let report_event = work_event(
        "event_pause_race_01",
        "share_pause_race_01",
        session_id,
        difficulty_one_target(),
    )?;
    let report_clock = WorkerClock::new("boot_pause_race_01", 1_100)?;
    let report =
        tokio::spawn(async move { adapter.report(report_event, &lease, report_clock).await });
    wait_for_blocked_query(&pool, "%work_requirement::text AS work_requirement%").await?;

    // Act
    blocker.commit().await?;
    let pause = pause.await??;
    let report = report.await?;
    let lifecycle = fixture.lifecycle(&challenge_id).await?;

    // Assert
    assert_eq!(pause.status().as_u16(), 200);
    assert!(matches!(
        report,
        Err(AuthorityApplicationError::ForbiddenLifecycleTransition)
    ));
    assert_eq!(lifecycle["verified_progress"], "0");

    Ok(())
}

#[tokio::test]
async fn cancel_serializes_before_session_registration() -> Result<(), Box<dyn Error>> {
    // Arrange
    let fixture = LifecycleFixture::start().await?;
    let challenge_id = fixture
        .create_challenge("action_cancel_register_race_01")
        .await?;
    let active_session_id =
        WorkSessionId::try_from("session_cancel_register_active_01".to_owned())?;
    fixture
        .adapter
        .register_session(&challenge_id, active_session_id.clone())
        .await?;
    fixture
        .adapter
        .start_lease(
            &active_session_id,
            WorkerClock::new("boot_cancel_register_race_01", 1_000)?,
        )
        .await?;
    let pool = sqlx::PgPool::connect(fixture._database.database_url()).await?;
    let mut blocker = pool.begin().await?;
    sqlx::query(
        "SELECT session_id FROM gate_authority.work_sessions
         WHERE session_id = $1 FOR UPDATE",
    )
    .bind("session_cancel_register_active_01")
    .execute(&mut *blocker)
    .await?;
    let cancel_url = format!(
        "{}/v0/challenges/{}/cancel",
        fixture.authority_url,
        challenge_id.as_str()
    );
    let cancel = tokio::spawn(async move {
        reqwest::Client::new()
            .post(cancel_url)
            .header(CLIENT_ID_HEADER, CLIENT_ID)
            .bearer_auth(SERVICE_SECRET)
            .json(&json!({ "confirm_progress_loss": true }))
            .send()
            .await
    });
    wait_for_blocked_query(&pool, "%UPDATE gate_authority.work_sessions%").await?;
    let adapter = fixture.adapter.clone();
    let registration_challenge_id = challenge_id.clone();
    let late_session_id = WorkSessionId::try_from("session_cancel_register_late_01".to_owned())?;
    let registration = tokio::spawn(async move {
        adapter
            .register_session(&registration_challenge_id, late_session_id)
            .await
    });
    wait_for_blocked_query(&pool, "%SELECT lifecycle_state, expires_at_unix_seconds%").await?;

    // Act
    blocker.commit().await?;
    let cancel = cancel.await??;
    let registration = registration.await?;
    let late_session_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM gate_authority.work_sessions
         WHERE session_id = 'session_cancel_register_late_01'",
    )
    .fetch_one(&pool)
    .await?;

    // Assert
    assert_eq!(cancel.status().as_u16(), 200);
    assert!(matches!(
        registration,
        Err(AuthorityApplicationError::ForbiddenLifecycleTransition)
    ));
    assert_eq!(late_session_count, 0);

    Ok(())
}

async fn wait_for_blocked_query(
    pool: &sqlx::PgPool,
    query_pattern: &str,
) -> Result<(), Box<dyn Error>> {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let waiting = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS (
                    SELECT 1 FROM pg_stat_activity
                    WHERE datname = current_database()
                      AND pid <> pg_backend_pid()
                      AND wait_event_type = 'Lock'
                      AND query LIKE $1
                )",
            )
            .bind(query_pattern)
            .fetch_one(pool)
            .await?;
            if waiting {
                return Ok::<(), sqlx::Error>(());
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .map_err(|_| "database query did not reach the expected lock wait")??;
    Ok(())
}
