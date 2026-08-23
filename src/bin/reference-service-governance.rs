use std::error::Error;

use bwg_core::governance::{GovernanceContext, cli};

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    cli::run(GovernanceContext::RelyingService).await?;
    Ok(())
}
