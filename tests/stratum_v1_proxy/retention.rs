use super::*;
use bwg_core::governance::HOSTED_OPERATIONAL_RETENTION_SECONDS;

#[tokio::test]
async fn pool_adapter_retirement_is_bounded_idempotent_and_releases_extranonce_space()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let registry = PostgresStratumSessionRegistry::connect(database.database_url()).await?;
    let outbox = PostgresAcceptedWorkOutbox::connect(database.database_url()).await?;
    let retention = PostgresPoolAdapterRetention::connect(database.database_url()).await?;
    let as_of = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let started_at = as_of
        .checked_sub(HOSTED_OPERATIONAL_RETENTION_SECONDS + 120)
        .ok_or("test clock must be later than the hosted retention floor")?;
    let session_id = WorkSessionId::try_from("session_stratum_retention_01".to_owned())?;
    let credentials = StratumCredentialIssuer::new([21_u8; 32]).issue(
        session_id.clone(),
        test_lease_context()?,
        started_at,
        started_at + 60,
        started_at + 300,
    )?;
    registry.register(&credentials).await?;
    registry
        .reserve_extranonce(
            &session_id,
            "00000000-0000-4000-8000-000000000201",
            "aabbccdd",
            started_at,
        )
        .await?;
    registry
        .reserve_connection(
            "00000000-0000-4000-8000-000000000202",
            "11223344",
            started_at,
        )
        .await?;
    let event = persisted_event("event_stratum_retention_01", "share_stratum_retention_01")?;
    outbox
        .persist(
            &event,
            &test_lease_context()?,
            r#"{"id":31,"result":true,"error":null}"#,
        )
        .await?;
    let claimed = outbox
        .claim_next("delivery_worker_retention", 1_001, 1_031)
        .await?
        .ok_or("retention event must be claimable")?;
    outbox.acknowledge(&claimed, 1_002).await?;
    // Act
    let below_floor = retention
        .retire(as_of, HOSTED_OPERATIONAL_RETENTION_SECONDS - 1, 100)
        .await;
    let future_as_of = retention
        .retire(as_of + 60, HOSTED_OPERATIONAL_RETENTION_SECONDS, 100)
        .await;
    let counts = retention
        .retire(as_of, HOSTED_OPERATIONAL_RETENTION_SECONDS, 100)
        .await?;
    let repeated = retention
        .retire(as_of, HOSTED_OPERATIONAL_RETENTION_SECONDS, 100)
        .await?;
    let authentication = registry
        .authenticate(credentials.username(), credentials.secret(), as_of)
        .await?;
    let maybe_event = outbox
        .claim_next("delivery_worker_after_retention", as_of, as_of + 30)
        .await?;

    // Assert
    assert!(matches!(
        below_floor,
        Err(StratumV1Error::InvalidRetentionPolicy)
    ));
    assert!(matches!(
        future_as_of,
        Err(StratumV1Error::InvalidRetentionPolicy)
    ));
    assert_eq!(counts.connections, 2);
    assert_eq!(counts.sessions, 1);
    assert_eq!(counts.settled_events, 1);
    assert_eq!(
        repeated,
        PoolAdapterRetentionCounts {
            connections: 0,
            sessions: 0,
            settled_events: 0,
        }
    );
    assert!(authentication.is_none());
    assert!(maybe_event.is_none());
    Ok(())
}

/// Seeds one expired session with two connections (one reserved through it, one on its
/// own) and one settled share record, and returns an instant past the floor for all.
pub(super) async fn seed_expired_records(database_url: &str) -> Result<u64, Box<dyn Error>> {
    let registry = PostgresStratumSessionRegistry::connect(database_url).await?;
    let outbox = PostgresAcceptedWorkOutbox::connect(database_url).await?;
    let as_of = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let started_at = as_of
        .checked_sub(HOSTED_OPERATIONAL_RETENTION_SECONDS + 120)
        .ok_or("test clock must be later than the hosted retention floor")?;
    let session_id = WorkSessionId::try_from("session_stratum_retention_seed".to_owned())?;
    let credentials = StratumCredentialIssuer::new([22_u8; 32]).issue(
        session_id.clone(),
        test_lease_context()?,
        started_at,
        started_at + 60,
        started_at + 300,
    )?;
    registry.register(&credentials).await?;
    registry
        .reserve_extranonce(
            &session_id,
            "00000000-0000-4000-8000-000000000301",
            "a1b2c3d4",
            started_at,
        )
        .await?;
    registry
        .reserve_connection(
            "00000000-0000-4000-8000-000000000302",
            "51525354",
            started_at,
        )
        .await?;
    let event = persisted_event(
        "event_stratum_retention_seed",
        "share_stratum_retention_seed",
    )?;
    outbox
        .persist(
            &event,
            &test_lease_context()?,
            r#"{"id":41,"result":true,"error":null}"#,
        )
        .await?;
    let claimed = outbox
        .claim_next("delivery_worker_retention_seed", 1_001, 1_031)
        .await?
        .ok_or("seeded event must be claimable")?;
    outbox.acknowledge(&claimed, 1_002).await?;
    Ok(as_of)
}

async fn register_expired_session(
    registry: &PostgresStratumSessionRegistry,
    session_id: &str,
    as_of: u64,
) -> Result<(), Box<dyn Error>> {
    let started_at = as_of
        .checked_sub(HOSTED_OPERATIONAL_RETENTION_SECONDS + 120)
        .ok_or("test clock must be later than the hosted retention floor")?;
    let credentials = StratumCredentialIssuer::new([23_u8; 32]).issue(
        WorkSessionId::try_from(session_id.to_owned())?,
        test_lease_context()?,
        started_at,
        started_at + 60,
        started_at + 300,
    )?;
    registry.register(&credentials).await?;
    Ok(())
}

const SEEDED_COUNTS: PoolAdapterRetentionCounts = PoolAdapterRetentionCounts {
    connections: 2,
    sessions: 1,
    settled_events: 1,
};

#[tokio::test]
async fn pool_adapter_count_matches_what_a_full_run_deletes() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let as_of = seed_expired_records(database.database_url()).await?;
    let retention = PostgresPoolAdapterRetention::connect(database.database_url()).await?;

    // Act
    let before = retention
        .count_expired(as_of, HOSTED_OPERATIONAL_RETENTION_SECONDS)
        .await?;
    let deleted = retention
        .retire_until_done(as_of, HOSTED_OPERATIONAL_RETENTION_SECONDS, 1)
        .await?;
    let after = retention
        .count_expired(as_of, HOSTED_OPERATIONAL_RETENTION_SECONDS)
        .await?;

    // Assert
    assert_eq!(before, SEEDED_COUNTS);
    assert_eq!(deleted, SEEDED_COUNTS);
    assert!(after.is_empty());
    Ok(())
}

#[tokio::test]
async fn pool_adapter_count_rejects_a_future_instant_and_a_short_period()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let retention = PostgresPoolAdapterRetention::connect(database.database_url()).await?;
    let as_of = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();

    // Act
    let future = retention
        .count_expired(as_of + 60, HOSTED_OPERATIONAL_RETENTION_SECONDS)
        .await;
    let short = retention
        .count_expired(as_of, HOSTED_OPERATIONAL_RETENTION_SECONDS - 1)
        .await;

    // Assert
    assert!(matches!(
        future,
        Err(StratumV1Error::InvalidRetentionPolicy)
    ));
    assert!(matches!(short, Err(StratumV1Error::InvalidRetentionPolicy)));
    Ok(())
}

#[tokio::test]
async fn pool_adapter_retirement_keeps_unsettled_share_records() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let outbox = PostgresAcceptedWorkOutbox::connect(database.database_url()).await?;
    let retention = PostgresPoolAdapterRetention::connect(database.database_url()).await?;
    let as_of = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    for (event_id, share_id) in [
        ("event_stratum_unsettled_01", "share_stratum_unsettled_01"),
        ("event_stratum_unsettled_02", "share_stratum_unsettled_02"),
    ] {
        outbox
            .persist(
                &persisted_event(event_id, share_id)?,
                &test_lease_context()?,
                r#"{"id":51,"result":true,"error":null}"#,
            )
            .await?;
    }
    outbox
        .claim_next("delivery_worker_unsettled", 1_001, 1_031)
        .await?
        .ok_or("one event must be claimable")?;
    let pool = sqlx::PgPool::connect(database.database_url()).await?;

    // Act
    let deleted = retention
        .retire_until_done(as_of, HOSTED_OPERATIONAL_RETENTION_SECONDS, 100)
        .await?;
    let remaining: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pool_adapter.accepted_work_outbox")
            .fetch_one(&pool)
            .await?;

    // Assert
    assert_eq!(deleted.settled_events, 0);
    assert_eq!(remaining, 2);
    Ok(())
}

#[tokio::test]
async fn pool_adapter_retirement_skips_a_row_another_transaction_holds()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let registry = PostgresStratumSessionRegistry::connect(database.database_url()).await?;
    let retention = PostgresPoolAdapterRetention::connect(database.database_url()).await?;
    let as_of = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    register_expired_session(&registry, "session_stratum_locked_01", as_of).await?;
    register_expired_session(&registry, "session_stratum_locked_02", as_of).await?;
    let pool = sqlx::PgPool::connect(database.database_url()).await?;
    let mut holder = pool.begin().await?;
    sqlx::query(
        "SELECT session_id FROM pool_adapter.stratum_sessions WHERE session_id = $1 FOR UPDATE",
    )
    .bind("session_stratum_locked_01")
    .fetch_one(&mut *holder)
    .await?;

    // Act
    let while_held = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        retention.retire(as_of, HOSTED_OPERATIONAL_RETENTION_SECONDS, 100),
    )
    .await;
    holder.rollback().await?;
    let after_release = retention
        .retire(as_of, HOSTED_OPERATIONAL_RETENTION_SECONDS, 100)
        .await?;

    // Assert
    let while_held = while_held.map_err(|_| "a held row stalled the retention run")??;
    assert_eq!(while_held.sessions, 1);
    assert_eq!(after_release.sessions, 1);
    Ok(())
}

#[tokio::test]
async fn pool_adapter_retirement_skips_a_connection_another_transaction_holds()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let registry = PostgresStratumSessionRegistry::connect(database.database_url()).await?;
    let retention = PostgresPoolAdapterRetention::connect(database.database_url()).await?;
    let as_of = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let reserved_at = as_of
        .checked_sub(HOSTED_OPERATIONAL_RETENTION_SECONDS + 120)
        .ok_or("test clock must be later than the hosted retention floor")?;
    let held = "00000000-0000-4000-8000-000000000401";
    registry
        .reserve_connection(held, "61626364", reserved_at)
        .await?;
    registry
        .reserve_connection(
            "00000000-0000-4000-8000-000000000402",
            "71727374",
            reserved_at,
        )
        .await?;
    let pool = sqlx::PgPool::connect(database.database_url()).await?;
    let mut holder = pool.begin().await?;
    sqlx::query(
        "SELECT connection_id FROM pool_adapter.stratum_connections
         WHERE connection_id = $1::uuid FOR UPDATE",
    )
    .bind(held)
    .fetch_one(&mut *holder)
    .await?;

    // Act
    let while_held = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        retention.retire(as_of, HOSTED_OPERATIONAL_RETENTION_SECONDS, 100),
    )
    .await;
    holder.rollback().await?;

    // Assert
    let while_held = while_held.map_err(|_| "a held connection stalled the retention run")??;
    assert_eq!(while_held.connections, 1);
    Ok(())
}

#[tokio::test]
async fn pool_adapter_retirement_skips_a_share_record_another_transaction_holds()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let outbox = PostgresAcceptedWorkOutbox::connect(database.database_url()).await?;
    let retention = PostgresPoolAdapterRetention::connect(database.database_url()).await?;
    let as_of = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    for (index, (event_id, share_id)) in [
        ("event_stratum_held_01", "share_stratum_held_01"),
        ("event_stratum_held_02", "share_stratum_held_02"),
    ]
    .into_iter()
    .enumerate()
    {
        outbox
            .persist(
                &persisted_event(event_id, share_id)?,
                &test_lease_context()?,
                r#"{"id":61,"result":true,"error":null}"#,
            )
            .await?;
        let claimed = outbox
            .claim_next(&format!("delivery_worker_held_{index}"), 1_001, 1_031)
            .await?
            .ok_or("each event must be claimable")?;
        outbox.acknowledge(&claimed, 1_002).await?;
    }
    let pool = sqlx::PgPool::connect(database.database_url()).await?;
    let mut holder = pool.begin().await?;
    sqlx::query(
        "SELECT event_id FROM pool_adapter.accepted_work_outbox WHERE event_id = $1 FOR UPDATE",
    )
    .bind("event_stratum_held_01")
    .fetch_one(&mut *holder)
    .await?;

    // Act
    let while_held = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        retention.retire(as_of, HOSTED_OPERATIONAL_RETENTION_SECONDS, 100),
    )
    .await;
    holder.rollback().await?;

    // Assert
    let while_held = while_held.map_err(|_| "a held share record stalled the retention run")??;
    assert_eq!(while_held.settled_events, 1);
    Ok(())
}
