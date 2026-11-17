//! The `pool-adapter-governance` operator tool.

use std::{
    error::Error,
    process::{Command, Output},
};

use bwg_core::governance::HOSTED_OPERATIONAL_RETENTION_SECONDS;
use serde_json::{Value, json};

use super::{PostgresTestDatabase, retention::seed_expired_records};

fn governance(
    database_url: &str,
    arguments: &[&str],
    destructive: bool,
) -> std::io::Result<Output> {
    let mut command = Command::new(env!("CARGO_BIN_EXE_pool-adapter-governance"));
    command
        .env_clear()
        .env("BWG_POOL_ADAPTER_DATABASE_URL", database_url)
        .args(arguments);
    if destructive {
        command.env("BWG_GOVERNANCE_DESTRUCTIVE_ENABLED", "true");
    }
    command.output()
}

fn printed_counts(output: &Output) -> Result<Value, Box<dyn Error>> {
    if !output.status.success() {
        return Err(format!(
            "the tool failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    Ok(serde_json::from_slice(&output.stdout)?)
}

fn seeded_counts() -> Value {
    json!({"connections": 2, "sessions": 1, "settled_events": 1})
}

fn empty_counts() -> Value {
    json!({"connections": 0, "sessions": 0, "settled_events": 0})
}

#[test]
fn pool_adapter_cli_publishes_its_commands() -> Result<(), Box<dyn Error>> {
    // Act
    let output = Command::new(env!("CARGO_BIN_EXE_pool-adapter-governance"))
        .env_clear()
        .arg("--help")
        .output()?;
    let stdout = String::from_utf8(output.stdout)?;

    // Assert
    assert!(output.status.success());
    assert!(stdout.contains("count-expired"));
    assert!(stdout.contains("delete-expired"));
    Ok(())
}

#[tokio::test]
async fn pool_adapter_count_changes_nothing() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let as_of = seed_expired_records(database.database_url())
        .await?
        .to_string();
    let count = ["count-expired", "--as-of", as_of.as_str()];

    // Act
    let first = governance(database.database_url(), &count, true)?;
    let second = governance(database.database_url(), &count, true)?;

    // Assert
    assert_eq!(printed_counts(&first)?, seeded_counts());
    assert_eq!(printed_counts(&second)?, seeded_counts());
    Ok(())
}

#[tokio::test]
async fn pool_adapter_delete_refuses_without_the_destructive_switch() -> Result<(), Box<dyn Error>>
{
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let as_of = seed_expired_records(database.database_url())
        .await?
        .to_string();

    // Act
    let refused = governance(
        database.database_url(),
        &["delete-expired", "--as-of", &as_of, "--confirm-destruction"],
        false,
    )?;
    let after = governance(
        database.database_url(),
        &["count-expired", "--as-of", &as_of],
        false,
    )?;

    // Assert
    assert!(!refused.status.success());
    assert_eq!(printed_counts(&after)?, seeded_counts());
    Ok(())
}

#[tokio::test]
async fn pool_adapter_delete_refuses_without_confirmation() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let as_of = seed_expired_records(database.database_url())
        .await?
        .to_string();

    // Act
    let refused = governance(
        database.database_url(),
        &["delete-expired", "--as-of", &as_of],
        true,
    )?;
    let after = governance(
        database.database_url(),
        &["count-expired", "--as-of", &as_of],
        true,
    )?;

    // Assert
    assert!(!refused.status.success());
    assert_eq!(printed_counts(&after)?, seeded_counts());
    Ok(())
}

#[tokio::test]
async fn pool_adapter_delete_removes_what_the_count_reported() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let as_of = seed_expired_records(database.database_url())
        .await?
        .to_string();
    let reported = governance(
        database.database_url(),
        &["count-expired", "--as-of", &as_of],
        true,
    )?;

    // Act
    let deleted = governance(
        database.database_url(),
        &[
            "delete-expired",
            "--as-of",
            &as_of,
            "--batch-size",
            "1",
            "--confirm-destruction",
        ],
        true,
    )?;
    let after = governance(
        database.database_url(),
        &["count-expired", "--as-of", &as_of],
        true,
    )?;

    // Assert
    assert_eq!(printed_counts(&deleted)?, printed_counts(&reported)?);
    assert_eq!(printed_counts(&after)?, empty_counts());
    Ok(())
}

#[tokio::test]
async fn pool_adapter_cli_rejects_a_period_under_the_floor() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let as_of = seed_expired_records(database.database_url())
        .await?
        .to_string();
    let short = (HOSTED_OPERATIONAL_RETENTION_SECONDS - 1).to_string();

    // Act
    let output = governance(
        database.database_url(),
        &[
            "count-expired",
            "--as-of",
            &as_of,
            "--retention-seconds",
            &short,
        ],
        true,
    )?;

    // Assert
    assert!(!output.status.success());
    Ok(())
}

#[tokio::test]
async fn pool_adapter_delete_refuses_an_unknown_option() -> Result<(), Box<dyn Error>> {
    // Arrange
    let database = PostgresTestDatabase::start().await?;
    let as_of = seed_expired_records(database.database_url())
        .await?
        .to_string();

    // Act
    let refused = governance(
        database.database_url(),
        &[
            "delete-expired",
            "--as-of",
            &as_of,
            "--retention-second",
            "7776000",
            "--confirm-destruction",
        ],
        true,
    )?;
    let after = governance(
        database.database_url(),
        &["count-expired", "--as-of", &as_of],
        true,
    )?;

    // Assert
    assert!(!refused.status.success());
    assert_eq!(printed_counts(&after)?, seeded_counts());
    Ok(())
}
