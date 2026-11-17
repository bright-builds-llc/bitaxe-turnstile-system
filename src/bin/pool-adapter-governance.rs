use std::error::Error;

use bwg_core::stratum_v1::governance_cli;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    governance_cli::run().await?;
    Ok(())
}
