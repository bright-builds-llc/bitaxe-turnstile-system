//! The rehearsal's regtest node, reached only from the control listener, so a run can
//! put a new Bitcoin tip under a live Work Lease.

use std::error::Error;

use serde_json::{Value, json};

type ChainResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

pub(crate) struct RegtestChain {
    client: reqwest::Client,
    rpc_url: String,
    rpc_user: String,
    rpc_password: String,
    mining_address: String,
}

impl RegtestChain {
    /// Reads the throwaway regtest RPC settings the rehearsal script generated.
    pub(crate) fn from_env() -> Result<Self, Box<dyn Error>> {
        let var = |name: &str| std::env::var(name).map_err(|_| format!("{name} is required"));
        Ok(Self {
            client: reqwest::Client::new(),
            rpc_url: var("BWG_REHEARSAL_BITCOIN_RPC_URL")?,
            rpc_user: var("BWG_REHEARSAL_BITCOIN_RPC_USER")?,
            rpc_password: var("BWG_REHEARSAL_BITCOIN_RPC_PASSWORD")?,
            mining_address: var("BWG_REHEARSAL_MINING_ADDRESS")?,
        })
    }

    /// Mines one block and returns its hash.
    pub(crate) async fn mine_block(&self) -> ChainResult<Value> {
        let response: Value = self
            .client
            .post(&self.rpc_url)
            .basic_auth(&self.rpc_user, Some(&self.rpc_password))
            .json(&json!({
                "jsonrpc": "1.0",
                "id": "rehearsal",
                "method": "generatetoaddress",
                "params": [1, self.mining_address],
            }))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let hash = response["result"][0]
            .as_str()
            .ok_or("generatetoaddress returned no block")?;
        Ok(json!({ "block": hash }))
    }
}
