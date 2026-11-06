//! A paced CPU Stratum V1 miner that stands in for the board's ASIC in the rehearsal.

use std::{
    error::Error,
    net::SocketAddr,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use bitcoin::hex::FromHex as _;
use ring::digest;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader},
    net::{TcpStream, tcp::OwnedWriteHalf},
};

use crate::stratum_hash_support::coinbase_txid;

type MinerResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

/// One share per tick keeps delivery observable without flooding the regtest pool.
const SHARE_INTERVAL: Duration = Duration::from_millis(500);
const MAXIMUM_NONCES_PER_SHARE: u32 = 1 << 22;
/// Stays just inside the pool's target so float rounding never yields a low share.
const TARGET_SAFETY: f64 = 0.999;

#[derive(Default)]
pub(crate) struct MinerStats {
    pub(crate) submitted: AtomicU64,
    pub(crate) accepted: AtomicU64,
    pub(crate) rejected: AtomicU64,
}

struct Subscription {
    extranonce1: String,
    extranonce2_bytes: usize,
}

/// Mines with the Worker's Stratum credentials until the connection ends.
pub(crate) async fn run(
    address: SocketAddr,
    username: String,
    password: String,
    stats: std::sync::Arc<MinerStats>,
) -> MinerResult<()> {
    let (reader, mut writer) = TcpStream::connect(address).await?.into_split();
    let mut lines = BufReader::new(reader).lines();
    send(
        &mut writer,
        json!({"id": 1, "method": "mining.subscribe", "params": ["bwg-rehearsal-miner/0.1"]}),
    )
    .await?;
    let mut maybe_subscription = None;
    let mut maybe_difficulty = None;
    let mut maybe_job: Option<Vec<Value>> = None;
    let mut authorized = false;
    let mut next_id = 3_u64;
    let mut extranonce_counter = 0_u64;
    let mut tick = tokio::time::interval(SHARE_INTERVAL);
    loop {
        tokio::select! {
            line = lines.next_line() => {
                let Some(line) = line? else { return Ok(()) };
                let message: Value = serde_json::from_str(&line)?;
                match (message["id"].as_u64(), message["method"].as_str()) {
                    (Some(1), _) => {
                        maybe_subscription = Some(subscription(&message)?);
                        send(&mut writer, json!({
                            "id": 2, "method": "mining.authorize", "params": [username, password]
                        })).await?;
                    }
                    (Some(2), _) => {
                        authorized = message["result"] == Value::Bool(true);
                        if !authorized {
                            return Err("Stratum authorization was refused".into());
                        }
                    }
                    (_, Some("mining.set_difficulty")) => {
                        maybe_difficulty = message["params"][0].as_f64();
                    }
                    (_, Some("mining.notify")) => {
                        maybe_job = message["params"].as_array().cloned();
                    }
                    (Some(_), None) => {
                        let counter = if message["result"] == Value::Bool(true) {
                            &stats.accepted
                        } else {
                            &stats.rejected
                        };
                        counter.fetch_add(1, Ordering::Relaxed);
                    }
                    _ => {}
                }
            }
            _ = tick.tick() => {
                let (true, Some(subscription), Some(difficulty), Some(job)) =
                    (authorized, &maybe_subscription, maybe_difficulty, &maybe_job)
                else {
                    continue;
                };
                extranonce_counter += 1;
                let extranonce2 = counter_hex(extranonce_counter, subscription.extranonce2_bytes);
                let target = target_from_difficulty(difficulty);
                let Some((ntime, nonce)) = solve(job, &subscription.extranonce1, &extranonce2, target)? else {
                    continue;
                };
                send(&mut writer, json!({
                    "id": next_id,
                    "method": "mining.submit",
                    "params": [username, job[0], extranonce2, ntime, nonce]
                })).await?;
                next_id += 1;
                stats.submitted.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

fn subscription(message: &Value) -> MinerResult<Subscription> {
    let extranonce1 = message["result"][1]
        .as_str()
        .ok_or("subscribe result needs extranonce1")?
        .to_owned();
    let extranonce2_bytes = usize::try_from(
        message["result"][2]
            .as_u64()
            .ok_or("subscribe result needs the extranonce2 size")?,
    )?;
    Ok(Subscription {
        extranonce1,
        extranonce2_bytes,
    })
}

async fn send(writer: &mut OwnedWriteHalf, message: Value) -> MinerResult<()> {
    let mut line = serde_json::to_vec(&message)?;
    line.push(b'\n');
    writer.write_all(&line).await?;
    Ok(())
}

fn counter_hex(counter: u64, bytes: usize) -> String {
    let full = format!("{counter:016x}");
    let width = bytes * 2;
    if width >= full.len() {
        format!("{full:0>width$}")
    } else {
        full[full.len() - width..].to_owned()
    }
}

/// Converts a pool difficulty into a big-endian 256-bit target, capped at the maximum.
fn target_from_difficulty(difficulty: f64) -> [u8; 32] {
    let difficulty_one = 65_535.0 * 2_f64.powi(208);
    let target = difficulty_one / difficulty * TARGET_SAFETY;
    if !target.is_finite() || target >= 2_f64.powi(256) {
        return [0xff; 32];
    }
    let mut bytes = [0_u8; 32];
    let mut remaining = target;
    for (index, byte) in bytes.iter_mut().enumerate() {
        let place = 2_f64.powi(8 * (31 - index as i32));
        let value = (remaining / place).floor().clamp(0.0, 255.0);
        *byte = value as u8;
        remaining -= value * place;
    }
    bytes
}

/// Finds a nonce whose header meets the share target but not the network target.
fn solve(
    job: &[Value],
    extranonce1: &str,
    extranonce2: &str,
    target: [u8; 32],
) -> MinerResult<Option<(String, String)>> {
    let field = |index: usize| -> MinerResult<&str> {
        job.get(index)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("notify field {index} must be a string").into())
    };
    let coinbase = Vec::<u8>::from_hex(&format!(
        "{}{extranonce1}{extranonce2}{}",
        field(2)?,
        field(3)?
    ))?;
    let mut merkle_root = coinbase_txid(&coinbase).map_err(|error| error.to_string())?;
    for branch in job
        .get(4)
        .and_then(Value::as_array)
        .ok_or("notify merkle branches must be an array")?
    {
        let mut joined = merkle_root.to_vec();
        joined.extend(Vec::<u8>::from_hex(branch.as_str().ok_or("branch")?)?);
        merkle_root = double_sha256(&joined);
    }
    let mut prefix = Vec::with_capacity(80);
    prefix.extend(reversed(field(5)?)?);
    let mut previous = Vec::<u8>::from_hex(field(1)?)?;
    for word in previous.chunks_exact_mut(4) {
        word.reverse();
    }
    prefix.extend(previous);
    prefix.extend(merkle_root);
    prefix.extend(reversed(field(7)?)?);
    prefix.extend(reversed(field(6)?)?);
    let network_target = compact_target(field(6)?)?;
    for nonce in 0..MAXIMUM_NONCES_PER_SHARE {
        let mut header = prefix.clone();
        header.extend(nonce.to_le_bytes());
        let mut hash = double_sha256(&header);
        hash.reverse();
        if hash <= target && hash > network_target {
            return Ok(Some((field(7)?.to_owned(), format!("{nonce:08x}"))));
        }
    }
    Ok(None)
}

fn reversed(hex: &str) -> MinerResult<Vec<u8>> {
    let mut bytes = Vec::<u8>::from_hex(hex)?;
    bytes.reverse();
    Ok(bytes)
}

fn compact_target(bits: &str) -> MinerResult<[u8; 32]> {
    let encoded = u32::from_be_bytes(
        Vec::<u8>::from_hex(bits)?
            .try_into()
            .map_err(|_| "compact target bits")?,
    );
    let exponent = usize::try_from(encoded >> 24)?;
    let mantissa = encoded & 0x007f_ffff;
    let mut target = [0_u8; 32];
    let start = 32_usize
        .checked_sub(exponent)
        .ok_or("compact target exponent")?;
    for (offset, shift) in [16, 8, 0].into_iter().enumerate() {
        if let Some(byte) = target.get_mut(start + offset) {
            *byte = (mantissa >> shift) as u8;
        }
    }
    Ok(target)
}

fn double_sha256(input: &[u8]) -> [u8; 32] {
    let first = digest::digest(&digest::SHA256, input);
    let second = digest::digest(&digest::SHA256, first.as_ref());
    let mut output = [0_u8; 32];
    output.copy_from_slice(second.as_ref());
    output
}
