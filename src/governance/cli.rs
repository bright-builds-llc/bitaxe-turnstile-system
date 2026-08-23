//! Thin command-line adapter for context-local governance applications.

use std::{
    env,
    io::{self, Write as _},
    num::ParseIntError,
};

use thiserror::Error;

use super::{
    ApplyRetentionRequest, GovernanceApplication, GovernanceContext, GovernanceError,
    RetentionPolicy,
};

/// Runs one context-specific Service-Local Operator command.
pub async fn run(context: GovernanceContext) -> Result<(), GovernanceCliError> {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    let maybe_command = arguments.first().map(String::as_str);
    match maybe_command {
        None | Some("--help" | "-h" | "help") => write_help(context),
        Some("plan-retention") => plan_retention(context, &arguments[1..]).await,
        Some("apply-retention") => apply_retention(context, &arguments[1..]).await,
        Some("export") => Err(GovernanceCliError::ExportUnavailable),
        Some(command) => Err(GovernanceCliError::UnknownCommand(command.to_owned())),
    }
}

async fn apply_retention(
    context: GovernanceContext,
    arguments: &[String],
) -> Result<(), GovernanceCliError> {
    let job_id = required_string(arguments, "--job-id")?;
    let manifest_digest = required_string(arguments, "--manifest-digest")?;
    let batch_size = optional_u64(arguments, "--batch-size")?.unwrap_or(100);
    let confirmed = arguments
        .iter()
        .any(|argument| argument == "--confirm-destruction");
    let policy = retention_policy(arguments)?;
    let destructive_enabled =
        env::var("BWG_GOVERNANCE_DESTRUCTIVE_ENABLED").is_ok_and(|value| value == "true");
    let maybe_pseudonymization_key = env::var("BWG_GOVERNANCE_PSEUDONYMIZATION_KEY").ok();
    let request = ApplyRetentionRequest::new(
        job_id,
        manifest_digest,
        batch_size,
        destructive_enabled,
        confirmed,
        policy,
        maybe_pseudonymization_key.as_deref(),
    )?;
    let database_url = env::var(database_url_name(context))?;
    let application = GovernanceApplication::connect(context, &database_url).await?;
    let result = application.apply_retention(request).await?;
    let output = serde_json::to_vec(&result)?;
    let mut stdout = io::stdout().lock();
    stdout.write_all(&output)?;
    stdout.write_all(b"\n")?;
    Ok(())
}

async fn plan_retention(
    context: GovernanceContext,
    arguments: &[String],
) -> Result<(), GovernanceCliError> {
    let as_of_unix_seconds = required_u64(arguments, "--as-of")?;
    let policy = retention_policy(arguments)?;
    let database_url = env::var(database_url_name(context))?;
    let application = GovernanceApplication::connect(context, &database_url).await?;
    let manifest = application
        .plan_retention(as_of_unix_seconds, policy)
        .await?;
    let output = serde_json::to_vec(&manifest)?;
    let mut stdout = io::stdout().lock();
    stdout.write_all(&output)?;
    stdout.write_all(b"\n")?;
    Ok(())
}

fn retention_policy(arguments: &[String]) -> Result<RetentionPolicy, GovernanceCliError> {
    let hosted = RetentionPolicy::hosted_default();
    let operational = optional_u64(arguments, "--operational-retention-seconds")?
        .unwrap_or(hosted.operational_retention_seconds());
    let tombstone = optional_u64(arguments, "--tombstone-retention-seconds")?
        .unwrap_or(hosted.tombstone_retention_seconds());
    Ok(RetentionPolicy::new(operational, tombstone)?)
}

fn required_u64(arguments: &[String], name: &str) -> Result<u64, GovernanceCliError> {
    optional_u64(arguments, name)?.ok_or_else(|| GovernanceCliError::MissingOption(name.to_owned()))
}

fn required_string<'a>(arguments: &'a [String], name: &str) -> Result<&'a str, GovernanceCliError> {
    let Some(index) = arguments.iter().position(|argument| argument == name) else {
        return Err(GovernanceCliError::MissingOption(name.to_owned()));
    };
    arguments
        .get(index + 1)
        .map(String::as_str)
        .ok_or_else(|| GovernanceCliError::MissingOption(name.to_owned()))
}

fn optional_u64(arguments: &[String], name: &str) -> Result<Option<u64>, GovernanceCliError> {
    let Some(index) = arguments.iter().position(|argument| argument == name) else {
        return Ok(None);
    };
    let maybe_value = arguments.get(index + 1);
    let Some(value) = maybe_value else {
        return Err(GovernanceCliError::MissingOption(name.to_owned()));
    };
    Ok(Some(value.parse()?))
}

const fn database_url_name(context: GovernanceContext) -> &'static str {
    match context {
        GovernanceContext::GateAuthority => "BWG_AUTHORITY_DATABASE_URL",
        GovernanceContext::RelyingService => "BWG_RELYING_SERVICE_DATABASE_URL",
    }
}

fn write_help(context: GovernanceContext) -> Result<(), GovernanceCliError> {
    let help = format!(
        "BWG {} service-local governance\n\nCommands:\n  plan-retention\n  apply-retention\n  export\n",
        context.as_str()
    );
    io::stdout().write_all(help.as_bytes())?;
    Ok(())
}

/// Invalid command input or output failure at the CLI boundary.
#[derive(Debug, Error)]
pub enum GovernanceCliError {
    #[error("unknown governance command: {0}")]
    UnknownCommand(String),
    #[error("governance export is not enabled by the current schema profile")]
    ExportUnavailable,
    #[error("missing required option: {0}")]
    MissingOption(String),
    #[error("governance option must be an unsigned integer")]
    InvalidInteger(#[from] ParseIntError),
    #[error("required governance environment is unavailable")]
    Environment(#[from] env::VarError),
    #[error(transparent)]
    Governance(#[from] GovernanceError),
    #[error("governance output serialization failed")]
    Serialization(#[from] serde_json::Error),
    #[error("governance CLI output failed")]
    Output(#[from] io::Error),
}
