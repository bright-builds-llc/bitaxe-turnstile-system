//! Thin command-line adapter for the Pool Adapter's operator-run retention.
//!
//! Unlike the Gate Authority's and Relying Service's governance, the Pool Adapter keeps no
//! manifest, audit event or export: its expired records are deleted outright.

use std::{
    env,
    io::{self, Write as _},
};

use thiserror::Error;

use super::{PoolAdapterRetentionCounts, PostgresPoolAdapterRetention, StratumV1Error};
use crate::governance::{
    HOSTED_OPERATIONAL_RETENTION_SECONDS,
    cli::{optional_u64, required_u64},
};

const DEFAULT_BATCH_ROWS: u64 = 100;
const HELP: &str = "BWG pool_adapter service-local governance\n\nCommands:\n  count-expired --as-of <unix-seconds> [--retention-seconds <n>]\n  delete-expired --as-of <unix-seconds> [--retention-seconds <n>] [--batch-size <1..1000>] --confirm-destruction\n";

/// Runs one Pool Adapter operator command.
pub async fn run() -> Result<(), PoolAdapterGovernanceCliError> {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    match arguments.first().map(String::as_str) {
        None | Some("--help" | "-h" | "help") => Ok(io::stdout().write_all(HELP.as_bytes())?),
        Some("count-expired") => count_expired(&arguments[1..]).await,
        Some("delete-expired") => delete_expired(&arguments[1..]).await,
        Some(command) => Err(PoolAdapterGovernanceCliError::UnknownCommand(
            command.to_owned(),
        )),
    }
}

async fn count_expired(arguments: &[String]) -> Result<(), PoolAdapterGovernanceCliError> {
    refuse_unknown_arguments(arguments, &["--as-of", "--retention-seconds"], &[])?;
    let as_of = as_of(arguments)?;
    let retention_seconds = retention_seconds(arguments)?;
    let counts = connect()
        .await?
        .count_expired(as_of, retention_seconds)
        .await?;
    print_counts(counts)
}

async fn delete_expired(arguments: &[String]) -> Result<(), PoolAdapterGovernanceCliError> {
    refuse_unknown_arguments(
        arguments,
        &["--as-of", "--retention-seconds", "--batch-size"],
        &["--confirm-destruction"],
    )?;
    let as_of = as_of(arguments)?;
    let retention_seconds = retention_seconds(arguments)?;
    let batch_rows = optional_u64(arguments, "--batch-size")?.unwrap_or(DEFAULT_BATCH_ROWS);
    if !env::var("BWG_GOVERNANCE_DESTRUCTIVE_ENABLED").is_ok_and(|value| value == "true") {
        return Err(PoolAdapterGovernanceCliError::DestructiveDisabled);
    }
    if !arguments
        .iter()
        .any(|argument| argument == "--confirm-destruction")
    {
        return Err(PoolAdapterGovernanceCliError::Unconfirmed);
    }
    let counts = connect()
        .await?
        .retire_until_done(as_of, retention_seconds, batch_rows)
        .await?;
    print_counts(counts)
}

/// Refuses any argument that isn't a known option or an option's value, so a misspelled
/// option can't silently fall back to its default before an irreversible deletion.
fn refuse_unknown_arguments(
    arguments: &[String],
    options_with_values: &[&str],
    flags: &[&str],
) -> Result<(), PoolAdapterGovernanceCliError> {
    let mut remaining = arguments.iter();
    while let Some(argument) = remaining.next() {
        if options_with_values.contains(&argument.as_str()) {
            remaining.next();
            continue;
        }
        if !flags.contains(&argument.as_str()) {
            return Err(PoolAdapterGovernanceCliError::UnknownArgument(
                argument.clone(),
            ));
        }
    }
    Ok(())
}

fn as_of(arguments: &[String]) -> Result<u64, PoolAdapterGovernanceCliError> {
    Ok(required_u64(arguments, "--as-of")?)
}

fn retention_seconds(arguments: &[String]) -> Result<u64, PoolAdapterGovernanceCliError> {
    Ok(optional_u64(arguments, "--retention-seconds")?
        .unwrap_or(HOSTED_OPERATIONAL_RETENTION_SECONDS))
}

async fn connect() -> Result<PostgresPoolAdapterRetention, PoolAdapterGovernanceCliError> {
    let database_url = env::var("BWG_POOL_ADAPTER_DATABASE_URL")?;
    Ok(PostgresPoolAdapterRetention::connect(&database_url).await?)
}

fn print_counts(counts: PoolAdapterRetentionCounts) -> Result<(), PoolAdapterGovernanceCliError> {
    let mut stdout = io::stdout().lock();
    stdout.write_all(&serde_json::to_vec(&counts)?)?;
    stdout.write_all(b"\n")?;
    Ok(())
}

/// Invalid command input, a refused destruction, or a failure at the CLI boundary.
#[derive(Debug, Error)]
pub enum PoolAdapterGovernanceCliError {
    #[error("unknown governance command: {0}")]
    UnknownCommand(String),
    #[error("unknown governance argument: {0}")]
    UnknownArgument(String),
    #[error(transparent)]
    Arguments(#[from] crate::governance::cli::GovernanceCliError),
    #[error("destructive governance is disabled; set BWG_GOVERNANCE_DESTRUCTIVE_ENABLED=true")]
    DestructiveDisabled,
    #[error("delete-expired requires --confirm-destruction")]
    Unconfirmed,
    #[error("required governance environment is unavailable")]
    Environment(#[from] env::VarError),
    #[error(transparent)]
    Retention(#[from] StratumV1Error),
    #[error("governance output serialization failed")]
    Serialization(#[from] serde_json::Error),
    #[error("governance CLI output failed")]
    Output(#[from] io::Error),
}
