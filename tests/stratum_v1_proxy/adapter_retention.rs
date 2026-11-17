//! The `pool-adapter` process's opt-in retention sweep.

use std::{error::Error, time::Duration};

use bwg_core::{
    governance::HOSTED_OPERATIONAL_RETENTION_SECONDS, service_auth::ServiceSecret,
    stratum_v1::PostgresPoolAdapterRetention,
};

use super::{
    PostgresTestDatabase,
    adapter_process::{AdapterLaunch, WAIT_POLL, WAIT_TIMEOUT, free_loopback_address},
    retention::seed_expired_records,
};

const INTERVAL: (&str, &str) = ("BWG_POOL_ADAPTER_RETENTION_INTERVAL_SECONDS", "60");
const DESTRUCTIVE: (&str, &str) = ("BWG_GOVERNANCE_DESTRUCTIVE_ENABLED", "true");

/// A launch whose Authority and Mining Pool are never reached: the Authority's channel
/// connects lazily and the pool only when a Worker arrives.
async fn idle_launch(database: &PostgresTestDatabase) -> Result<AdapterLaunch, Box<dyn Error>> {
    Ok(AdapterLaunch {
        database_url: database.database_url().to_owned(),
        authority_address: free_loopback_address().await?,
        pool_address: free_loopback_address().await?,
        token_value: ServiceSecret::generate()?.expose_secret().to_owned(),
    })
}

#[tokio::test]
async fn adapter_sweep_deletes_expired_records_once_turned_on() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let as_of = seed_expired_records(database.database_url()).await?;
    let retention = PostgresPoolAdapterRetention::connect(database.database_url()).await?;
    let launch = idle_launch(&database).await?;

    // Act
    let _process = launch.start_with(&[INTERVAL, DESTRUCTIVE]).await?;
    let deadline = tokio::time::Instant::now() + WAIT_TIMEOUT;
    let mut remaining = retention
        .count_expired(as_of, HOSTED_OPERATIONAL_RETENTION_SECONDS)
        .await?;
    while !remaining.is_empty() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(WAIT_POLL).await;
        remaining = retention
            .count_expired(as_of, HOSTED_OPERATIONAL_RETENTION_SECONDS)
            .await?;
    }

    // Assert
    assert!(remaining.is_empty(), "the sweep left {remaining:?}");
    Ok(())
}

#[tokio::test]
async fn adapter_sweep_stays_off_without_the_destructive_switch() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let as_of = seed_expired_records(database.database_url()).await?;
    let retention = PostgresPoolAdapterRetention::connect(database.database_url()).await?;
    let before = retention
        .count_expired(as_of, HOSTED_OPERATIONAL_RETENTION_SECONDS)
        .await?;
    let launch = idle_launch(&database).await?;

    // Act
    let _process = launch.start_with(&[INTERVAL]).await?;
    tokio::time::sleep(Duration::from_secs(1)).await;
    let after = retention
        .count_expired(as_of, HOSTED_OPERATIONAL_RETENTION_SECONDS)
        .await?;

    // Assert
    assert!(!before.is_empty());
    assert_eq!(after, before);
    Ok(())
}

#[tokio::test]
async fn adapter_refuses_to_start_on_an_invalid_retention_setting() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let launch = idle_launch(&database).await?;

    // Act
    let (mut process, _registry_address) = launch
        .spawn_with(&[
            ("BWG_POOL_ADAPTER_RETENTION_INTERVAL_SECONDS", "59"),
            DESTRUCTIVE,
        ])
        .await?;
    let deadline = tokio::time::Instant::now() + WAIT_TIMEOUT;
    let mut maybe_status = process.child.try_wait()?;
    while maybe_status.is_none() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(WAIT_POLL).await;
        maybe_status = process.child.try_wait()?;
    }

    // Assert
    let status = maybe_status.ok_or("the adapter kept running on an invalid setting")?;
    assert!(!status.success());
    Ok(())
}
