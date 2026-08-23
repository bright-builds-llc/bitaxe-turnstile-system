use std::{env, error::Error};

use bwg_core::{
    crypto_profile::AuthorityJwkWire,
    reference_service::{self, ActionProcessingOutcome, ActionWorkerId},
};
use tokio::net::TcpListener;
use uuid::Uuid;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error + Send + Sync>> {
    tracing_subscriber::fmt().try_init()?;
    let authority_base_url = env::var("BWG_AUTHORITY_BASE_URL")?;
    let service_client_id = env::var("BWG_SERVICE_CLIENT_ID")?;
    let service_credential = env::var("BWG_SERVICE_CREDENTIAL")?;
    let trusted_authority_issuer = env::var("BWG_TRUSTED_AUTHORITY_ISSUER")?;
    let relying_service_audience = env::var("BWG_RELYING_SERVICE_AUDIENCE")?;
    let redemption_url = env::var("BWG_REDEMPTION_URL")?;
    let trusted_authority_keys = serde_json::from_str::<Vec<AuthorityJwkWire>>(&env::var(
        "BWG_TRUSTED_AUTHORITY_JWKS_JSON",
    )?)?;
    let trusted_authority =
        reference_service::TrustedAuthority::new(trusted_authority_issuer, trusted_authority_keys)?;
    let mut config = reference_service::Config::new(
        authority_base_url,
        service_client_id,
        service_credential,
        relying_service_audience,
        redemption_url,
        trusted_authority,
    )?
    .with_account_creation_executor();
    let maybe_window = env::var("BWG_OUTCOME_LOOKUP_WINDOW_SECONDS").ok();
    if let Some(window) = maybe_window {
        config = config.with_outcome_lookup_window_seconds(window.parse()?)?;
    }
    let application = reference_service::ReferenceApplication::connect_postgres(
        config,
        &env::var("BWG_RELYING_SERVICE_DATABASE_URL")?,
    )
    .await?;
    let action_application = application.clone();
    let action_worker_id =
        ActionWorkerId::try_from(format!("action_worker_{}", Uuid::new_v4().simple()))?;
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(250));
        loop {
            interval.tick().await;
            let now = match std::time::SystemTime::UNIX_EPOCH.elapsed() {
                Ok(duration) => duration.as_secs(),
                Err(error) => {
                    tracing::error!(%error, "system clock is unavailable to action worker");
                    continue;
                }
            };
            match action_application
                .process_next_action(&action_worker_id, now)
                .await
            {
                Ok(ActionProcessingOutcome::Succeeded { redemption_id }) => {
                    tracing::info!(%redemption_id, "Protected Action succeeded");
                }
                Ok(ActionProcessingOutcome::Failed { redemption_id }) => {
                    tracing::warn!(%redemption_id, "Protected Action failed");
                }
                Ok(ActionProcessingOutcome::RetryScheduled { redemption_id }) => {
                    tracing::info!(%redemption_id, "Protected Action retry scheduled");
                }
                Ok(ActionProcessingOutcome::NoWork) => {}
                Err(error) => {
                    tracing::warn!(%error, "Protected Action iteration failed");
                }
            }
        }
    });
    let listen_address =
        env::var("BWG_LISTEN_ADDRESS").unwrap_or_else(|_| "127.0.0.1:3001".to_owned());
    let listener = TcpListener::bind(&listen_address).await?;
    tracing::info!(%listen_address, "reference service listening");

    axum::serve(listener, reference_service::router(application)).await?;

    Ok(())
}
