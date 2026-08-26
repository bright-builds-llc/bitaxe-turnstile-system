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
    assert_eq!(counts.acknowledged_events, 1);
    assert_eq!(
        repeated,
        PoolAdapterRetentionCounts {
            connections: 0,
            sessions: 0,
            acknowledged_events: 0,
        }
    );
    assert!(authentication.is_none());
    assert!(maybe_event.is_none());
    Ok(())
}
