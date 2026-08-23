use std::{env, error::Error};

use bwg_core::{crypto_profile::AuthorityJwkWire, reference_service};
use tokio::net::TcpListener;

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
    let listen_address =
        env::var("BWG_LISTEN_ADDRESS").unwrap_or_else(|_| "127.0.0.1:3001".to_owned());
    let listener = TcpListener::bind(&listen_address).await?;
    tracing::info!(%listen_address, "reference service listening");

    axum::serve(
        listener,
        reference_service::router(reference_service::Config::new(
            authority_base_url,
            service_client_id,
            service_credential,
            relying_service_audience,
            redemption_url,
            trusted_authority,
        )?),
    )
    .await?;

    Ok(())
}
