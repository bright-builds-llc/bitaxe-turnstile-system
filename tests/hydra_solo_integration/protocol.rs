use std::{error::Error, time::Duration};

use crate::stratum_hash_support::coinbase_txid;
use bitcoin::hex::FromHex as _;
use ring::digest;
use serde_json::Value;
use tokio::{
    io::{AsyncWriteExt as _, BufReader},
    time::timeout,
};

pub(super) async fn mine_regtest_block() -> Result<(), Box<dyn Error>> {
    let mining_address = std::env::var("BWG_BITCOIN_MINING_ADDRESS")?;
    bitcoin_rpc("generatetoaddress", serde_json::json!([1, mining_address])).await?;
    Ok(())
}

pub(super) async fn regtest_block_count() -> Result<u64, Box<dyn Error>> {
    let response = bitcoin_rpc("getblockcount", serde_json::json!([])).await?;
    response["result"]
        .as_u64()
        .ok_or_else(|| "Bitcoin Core block count must be an integer".into())
}

pub(super) async fn wait_for_block_height(expected: u64) -> Result<(), Box<dyn Error>> {
    timeout(Duration::from_secs(20), async {
        loop {
            if regtest_block_count().await? >= expected {
                return Ok::<_, Box<dyn Error>>(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await??;
    Ok(())
}

async fn bitcoin_rpc(method: &str, params: Value) -> Result<Value, Box<dyn Error>> {
    let rpc_url = std::env::var("BWG_BITCOIN_RPC_URL")?;
    let rpc_user = std::env::var("BWG_BITCOIN_RPC_USER")?;
    let rpc_password = std::env::var("BWG_BITCOIN_RPC_PASSWORD")?;
    let response = reqwest::Client::new()
        .post(rpc_url)
        .basic_auth(rpc_user, Some(rpc_password))
        .json(&serde_json::json!({
            "jsonrpc": "1.0",
            "id": "bwg-hydra-integration",
            "method": method,
            "params": params
        }))
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    if !response["error"].is_null() {
        return Err(format!("Bitcoin Core RPC failed: {}", response["error"]).into());
    }
    Ok(response)
}

pub(super) fn assigned_target(difficulty: &Value) -> Result<[u8; 32], Box<dyn Error>> {
    let scaled = (difficulty
        .as_f64()
        .ok_or("assigned difficulty must be numeric")?
        * 10_000_000_000.0)
        .round() as u64;
    let target = match scaled {
        1 | 2 => "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        3 => "c6addaa6b4000000000000000000000000000000000000000000000000000000",
        4 => "950263fd07000000000000000000000000000000000000000000000000000000",
        _ => return Err(format!("unexpected integration difficulty: {difficulty}").into()),
    };
    Ok(Vec::<u8>::from_hex(target)?
        .try_into()
        .map_err(|_| "target width")?)
}

pub(super) fn worked_nonce(
    notify_params: &[Value],
    extranonce1: &str,
    extranonce2: &str,
    target: [u8; 32],
    require_network_target: bool,
    minimum_nonce: u32,
) -> Result<String, Box<dyn Error>> {
    let string_at = |index: usize| {
        notify_params[index]
            .as_str()
            .ok_or_else(|| format!("notify parameter {index} must be a string"))
    };
    let branches = notify_params[4]
        .as_array()
        .ok_or("notify merkle branches must be an array")?;
    if !branches.is_empty() {
        return Err("integration solver currently requires an empty mempool template".into());
    }
    let coinbase = Vec::<u8>::from_hex(&format!(
        "{}{extranonce1}{extranonce2}{}",
        string_at(2)?,
        string_at(3)?
    ))?;
    let merkle_root = coinbase_txid(&coinbase)?;
    let mut prefix = Vec::with_capacity(76);
    let mut version = Vec::<u8>::from_hex(string_at(5)?)?;
    version.reverse();
    prefix.extend(version);
    let mut previous = Vec::<u8>::from_hex(string_at(1)?)?;
    for word in previous.chunks_exact_mut(4) {
        word.reverse();
    }
    prefix.extend(previous);
    prefix.extend(merkle_root);
    for index in [7, 6] {
        let mut value = Vec::<u8>::from_hex(string_at(index)?)?;
        value.reverse();
        prefix.extend(value);
    }
    let network_target = compact_target(string_at(6)?)?;
    for nonce in minimum_nonce..=u32::MAX {
        let mut header = prefix.clone();
        header.extend(nonce.to_le_bytes());
        let mut hash = double_sha256(&header);
        hash.reverse();
        let assigned = hash <= target;
        let network = hash <= network_target;
        if assigned && network == require_network_target {
            return Ok(format!("{nonce:08x}"));
        }
    }
    Err("no worked nonce exists".into())
}

fn compact_target(bits: &str) -> Result<[u8; 32], Box<dyn Error>> {
    let encoded = u32::from_be_bytes(Vec::<u8>::from_hex(bits)?.try_into().map_err(|_| "bits")?);
    let exponent = usize::try_from(encoded >> 24)?;
    let mantissa = encoded & 0x007f_ffff;
    let mut target = [0_u8; 32];
    let start = 32_usize
        .checked_sub(exponent)
        .ok_or("compact target exponent")?;
    target[start] = (mantissa >> 16) as u8;
    target[start + 1] = (mantissa >> 8) as u8;
    target[start + 2] = mantissa as u8;
    Ok(target)
}

fn double_sha256(input: &[u8]) -> [u8; 32] {
    let first = digest::digest(&digest::SHA256, input);
    digest::digest(&digest::SHA256, first.as_ref())
        .as_ref()
        .try_into()
        .expect("SHA-256 output is always 32 bytes")
}

pub(super) async fn wait_for_close<R>(
    lines: &mut tokio::io::Lines<BufReader<R>>,
) -> Result<(), Box<dyn Error>>
where
    R: tokio::io::AsyncRead + Unpin,
{
    timeout(Duration::from_secs(20), async {
        while lines.next_line().await?.is_some() {}
        Ok::<_, std::io::Error>(())
    })
    .await??;
    Ok(())
}

pub(super) async fn next_matching<R, P>(
    lines: &mut tokio::io::Lines<BufReader<R>>,
    predicate: P,
) -> Result<Value, Box<dyn Error>>
where
    R: tokio::io::AsyncRead + Unpin,
    P: Fn(&Value) -> bool,
{
    timeout(Duration::from_secs(20), async {
        loop {
            let line = lines
                .next_line()
                .await?
                .ok_or("Stratum connection closed before the expected message")?;
            let value = serde_json::from_str::<Value>(&line)?;
            if predicate(&value) {
                return Ok::<_, Box<dyn Error>>(value);
            }
        }
    })
    .await?
}

pub(super) async fn next_matching_recording<R, P>(
    lines: &mut tokio::io::Lines<BufReader<R>>,
    predicate: P,
    observed: &mut Vec<Value>,
) -> Result<Value, Box<dyn Error>>
where
    R: tokio::io::AsyncRead + Unpin,
    P: Fn(&Value) -> bool,
{
    timeout(Duration::from_secs(20), async {
        loop {
            let line = lines
                .next_line()
                .await?
                .ok_or("Stratum connection closed before the expected message")?;
            let value = serde_json::from_str::<Value>(&line)?;
            if predicate(&value) {
                return Ok::<_, Box<dyn Error>>(value);
            }
            observed.push(value);
        }
    })
    .await?
}

pub(super) async fn write_line<W>(writer: &mut W, line: &str) -> Result<(), std::io::Error>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    writer.write_all(line.as_bytes()).await?;
    writer.write_all(b"\n").await?;
    writer.flush().await
}
