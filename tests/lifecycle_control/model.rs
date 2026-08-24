use super::*;

#[test]
fn challenge_transition_matrix_is_explicit() {
    // Arrange
    let states = [
        ChallengeLifecycleState::Issued,
        ChallengeLifecycleState::Active,
        ChallengeLifecycleState::Satisfied,
        ChallengeLifecycleState::PassIssued,
        ChallengeLifecycleState::Cancelled,
        ChallengeLifecycleState::Expired,
    ];
    let allowed = [
        (
            ChallengeLifecycleState::Issued,
            ChallengeLifecycleState::Active,
        ),
        (
            ChallengeLifecycleState::Issued,
            ChallengeLifecycleState::Cancelled,
        ),
        (
            ChallengeLifecycleState::Issued,
            ChallengeLifecycleState::Expired,
        ),
        (
            ChallengeLifecycleState::Active,
            ChallengeLifecycleState::Satisfied,
        ),
        (
            ChallengeLifecycleState::Active,
            ChallengeLifecycleState::Cancelled,
        ),
        (
            ChallengeLifecycleState::Active,
            ChallengeLifecycleState::Expired,
        ),
        (
            ChallengeLifecycleState::Satisfied,
            ChallengeLifecycleState::PassIssued,
        ),
        (
            ChallengeLifecycleState::Satisfied,
            ChallengeLifecycleState::Expired,
        ),
        (
            ChallengeLifecycleState::PassIssued,
            ChallengeLifecycleState::Expired,
        ),
    ];

    // Act / Assert
    for from in states {
        for to in states {
            assert_eq!(
                challenge_transition_allowed(from, to),
                from == to || allowed.contains(&(from, to)),
                "unexpected challenge transition result for {from:?} -> {to:?}"
            );
        }
    }
}

#[test]
fn session_transition_matrix_is_explicit() {
    // Arrange
    let states = [
        SessionLifecycleState::Ready,
        SessionLifecycleState::Leased,
        SessionLifecycleState::Stopping,
        SessionLifecycleState::Restored,
        SessionLifecycleState::Failed,
    ];
    let allowed = [
        (SessionLifecycleState::Ready, SessionLifecycleState::Leased),
        (
            SessionLifecycleState::Ready,
            SessionLifecycleState::Stopping,
        ),
        (SessionLifecycleState::Ready, SessionLifecycleState::Failed),
        (
            SessionLifecycleState::Leased,
            SessionLifecycleState::Stopping,
        ),
        (SessionLifecycleState::Leased, SessionLifecycleState::Failed),
        (
            SessionLifecycleState::Stopping,
            SessionLifecycleState::Restored,
        ),
        (
            SessionLifecycleState::Stopping,
            SessionLifecycleState::Failed,
        ),
        (
            SessionLifecycleState::Restored,
            SessionLifecycleState::Leased,
        ),
        (
            SessionLifecycleState::Restored,
            SessionLifecycleState::Failed,
        ),
    ];

    // Act / Assert
    for from in states {
        for to in states {
            assert_eq!(
                session_transition_allowed(from, to),
                from == to || allowed.contains(&(from, to)),
                "unexpected session transition result for {from:?} -> {to:?}"
            );
        }
    }
}

#[test]
fn protocol_deadline_defaults_are_one_profile() {
    // Arrange / Act / Assert
    assert_eq!(WORK_CHALLENGE_TTL_SECONDS, 15 * 60);
    assert_eq!(WORK_LEASE_MAX_DURATION_SECONDS, 60);
    assert_eq!(WORK_LEASE_RENEWAL_SECONDS, 20);
    assert_eq!(DPOP_FRESHNESS_SECONDS, 60);
    assert_eq!(DPOP_ACCEPTANCE_WINDOW_SECONDS, 60);
    assert_eq!(GATE_PASS_TTL_SECONDS, 2 * 60);
    assert_eq!(PROTOCOL_CLOCK_SKEW_SECONDS, 0);
    assert!(request_proof_is_fresh(160, 100, DPOP_FRESHNESS_SECONDS));
    assert!(!request_proof_is_fresh(161, 100, DPOP_FRESHNESS_SECONDS));
    assert!(!request_proof_is_fresh(100, 101, DPOP_FRESHNESS_SECONDS));
    assert!(signed_artifact_is_time_valid(119, 100, 120));
    assert!(!signed_artifact_is_time_valid(120, 100, 120));
}

#[test]
fn challenge_commands_apply_the_shared_transition_policy() {
    // Arrange / Act / Assert
    assert_eq!(
        apply_challenge_command(
            ChallengeLifecycleState::Issued,
            ChallengeLifecycleCommand::StartWork,
        ),
        Ok(ChallengeLifecycleState::Active)
    );
    assert_eq!(
        apply_challenge_command(
            ChallengeLifecycleState::Active,
            ChallengeLifecycleCommand::Pause,
        ),
        Ok(ChallengeLifecycleState::Active)
    );
    assert_eq!(
        apply_challenge_command(
            ChallengeLifecycleState::Issued,
            ChallengeLifecycleCommand::Cancel,
        ),
        Ok(ChallengeLifecycleState::Cancelled)
    );
    assert!(
        apply_challenge_command(
            ChallengeLifecycleState::Satisfied,
            ChallengeLifecycleCommand::Cancel,
        )
        .is_err()
    );
}

#[test]
fn session_commands_apply_the_shared_transition_policy() {
    // Arrange / Act / Assert
    assert_eq!(
        apply_session_command(
            SessionLifecycleState::Ready,
            SessionLifecycleCommand::StartLease,
        ),
        Ok(SessionLifecycleState::Leased)
    );
    assert_eq!(
        apply_session_command(SessionLifecycleState::Leased, SessionLifecycleCommand::Stop,),
        Ok(SessionLifecycleState::Stopping)
    );
    assert_eq!(
        apply_session_command(
            SessionLifecycleState::Stopping,
            SessionLifecycleCommand::ConfirmRestored,
        ),
        Ok(SessionLifecycleState::Restored)
    );
    assert!(
        apply_session_command(
            SessionLifecycleState::Leased,
            SessionLifecycleCommand::StartLease,
        )
        .is_err()
    );
}

#[tokio::test]
async fn migration_terminates_legacy_sessions_without_pool_consent() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let bootstrap = sqlx::PgPool::connect(database.database_url()).await?;
    sqlx::query("CREATE SCHEMA gate_authority")
        .execute(&bootstrap)
        .await?;
    bootstrap.close().await;
    let options = sqlx::postgres::PgConnectOptions::from_str(database.database_url())?
        .options([("search_path", "gate_authority,public")]);
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await?;
    let full_migrator = sqlx::migrate!("./migrations/gate_authority");
    let legacy_migrator = sqlx::migrate::Migrator {
        migrations: Cow::Owned(full_migrator.iter().take(6).cloned().collect()),
        ..sqlx::migrate::Migrator::DEFAULT
    };
    legacy_migrator.run(&pool).await?;
    sqlx::raw_sql(
        "INSERT INTO gate_authority.work_challenges
           (challenge_id, descriptor, gate_pass_claims_seed, work_requirement,
            verified_progress, satisfied, expires_at_unix_seconds, terminal_at_unix_seconds)
         VALUES ('challenge_legacy_session', '{}'::jsonb, '{}'::jsonb, 10, 1, FALSE, 200, 200);
         INSERT INTO gate_authority.work_sessions (session_id, challenge_id)
         VALUES ('session_legacy_continuity', 'challenge_legacy_session');
         INSERT INTO gate_authority.work_sessions (session_id, challenge_id)
         VALUES ('session_legacy_without_event', 'challenge_legacy_session');
         INSERT INTO gate_authority.accepted_work_events
           (event_id, challenge_id, session_id, assigned_target, received_at_unix_seconds,
            share_fingerprint, network_target_outcome, disposition, credited_work,
            verified_progress, work_requirement, issuance_intent_created)
         VALUES ('event_legacy_continuity', 'challenge_legacy_session',
                 'session_legacy_continuity', '\\x01', 100, 'share_legacy_continuity',
                 'below_network_target', 'credited', 1, 1, 10, FALSE);",
    )
    .execute(&pool)
    .await?;

    // Act
    full_migrator.run(&pool).await?;
    let failed_sessions = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM gate_authority.work_sessions
         WHERE lifecycle_state = 'failed'
           AND stop_reason = 'migration_pool_selection_unknown'",
    )
    .fetch_one(&pool)
    .await?;
    let challenge_state = sqlx::query_scalar::<_, String>(
        "SELECT lifecycle_state FROM gate_authority.work_challenges
         WHERE challenge_id = 'challenge_legacy_session'",
    )
    .fetch_one(&pool)
    .await?;
    let arbitrary_reason = sqlx::query(
        "UPDATE gate_authority.work_sessions SET stop_reason = 'arbitrary_reason'
         WHERE session_id = 'session_legacy_continuity'",
    )
    .execute(&pool)
    .await;

    // Assert
    assert_eq!(failed_sessions, 2);
    assert_eq!(challenge_state, "expired");
    assert!(arbitrary_reason.is_err());

    Ok(())
}
