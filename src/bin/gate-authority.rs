use std::{env, error::Error};

use bwg_core::authority;
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error + Send + Sync>> {
    tracing_subscriber::fmt().try_init()?;
    let service_credential = env::var("BWG_SERVICE_CREDENTIAL")?;
    let listen_address =
        env::var("BWG_LISTEN_ADDRESS").unwrap_or_else(|_| "127.0.0.1:3000".to_owned());
    let listener = TcpListener::bind(&listen_address).await?;
    tracing::info!(%listen_address, "Gate Authority listening");

    axum::serve(
        listener,
        authority::router(authority::Config::new(service_credential)),
    )
    .await?;

    Ok(())
}
