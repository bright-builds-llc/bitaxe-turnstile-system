//! A paced CPU Stratum V1 miner that stands in for the board's ASIC in the rehearsal.
//! Like the board's firmware it opens with `mining.configure` for version rolling,
//! sends subscribe and authorize without waiting, and submits rolled version bits.
//! Like ESP-Miner it also submits its in-flight result for a job a new Bitcoin tip
//! retired, after the clean notify or after reconnecting when the pool closes.

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
/// The board gives up on a pool after three failed connections in a row.
const MAXIMUM_RECONNECTS: u64 = 3;
const RECONNECT_DELAY: Duration = Duration::from_secs(1);
/// The standard Stratum error code a pool answers a retired job's submit with.
const JOB_NOT_FOUND: u64 = 21;

#[derive(Default)]
pub(crate) struct MinerStats {
    pub(crate) submitted: AtomicU64,
    pub(crate) accepted: AtomicU64,
    pub(crate) rejected: AtomicU64,
    pub(crate) reconnects: AtomicU64,
    pub(crate) stale_answered: AtomicU64,
}

struct Subscription {
    extranonce1: String,
    extranonce2_bytes: usize,
}

/// Mines with the Worker's Stratum credentials, reconnecting when the pool closes.
pub(crate) async fn run(
    address: SocketAddr,
    username: String,
    password: String,
    stats: std::sync::Arc<MinerStats>,
) -> MinerResult<()> {
    let mut maybe_in_flight = None;
    for attempt in 0..=MAXIMUM_RECONNECTS {
        if attempt > 0 {
            stats.reconnects.fetch_add(1, Ordering::Relaxed);
            tokio::time::sleep(RECONNECT_DELAY).await;
        }
        maybe_in_flight =
            mine_connection(address, &username, &password, &stats, maybe_in_flight).await?;
    }
    Err("the pool kept closing the connection".into())
}

/// Mines one connection until the pool closes it, returning the last submit's params
/// so the next connection can submit that in-flight result first.
async fn mine_connection(
    address: SocketAddr,
    username: &str,
    password: &str,
    stats: &MinerStats,
    mut maybe_in_flight: Option<Value>,
) -> MinerResult<Option<Value>> {
    let (reader, mut writer) = TcpStream::connect(address).await?.into_split();
    let mut lines = BufReader::new(reader).lines();
    for request in [
        json!({"id": 1, "method": "mining.configure",
               "params": [["version-rolling"], {"version-rolling.mask": "ffffffff"}]}),
        json!({"id": 2, "method": "mining.subscribe", "params": ["bwg-rehearsal-miner/0.1"]}),
        json!({"id": 3, "method": "mining.authorize", "params": [username, password]}),
    ] {
        send(&mut writer, request).await?;
    }
    let mut maybe_version_mask = None;
    let mut maybe_subscription = None;
    let mut maybe_difficulty = None;
    let mut maybe_job: Option<Vec<Value>> = None;
    let mut maybe_last_submit: Option<Value> = None;
    let mut authorized = false;
    let mut next_id = 4_u64;
    let mut extranonce_counter = 0_u64;
    let mut tick = tokio::time::interval(SHARE_INTERVAL);
    loop {
        tokio::select! {
            line = lines.next_line() => {
                let Some(line) = line? else { return Ok(maybe_last_submit) };
                let message: Value = serde_json::from_str(&line)?;
                match (message["id"].as_u64(), message["method"].as_str()) {
                    (Some(1), _) => {
                        maybe_version_mask = Some(version_mask(&message)?);
                    }
                    (Some(2), _) => {
                        maybe_subscription = Some(subscription(&message)?);
                    }
                    (Some(3), _) => {
                        authorized = message["result"] == Value::Bool(true);
                        if !authorized {
                            return Err("Stratum authorization was refused".into());
                        }
                        if let Some(params) = maybe_in_flight.take() {
                            send(&mut writer, json!({"id": next_id, "method": "mining.submit", "params": params})).await?;
                            next_id += 1;
                        }
                    }
                    (_, Some("mining.set_difficulty")) => {
                        maybe_difficulty = message["params"][0].as_f64();
                    }
                    (_, Some("mining.notify")) => {
                        let new_tip = message["params"][8] == Value::Bool(true)
                            && maybe_job.as_ref().is_some_and(|job| job.get(1) != message["params"].get(1));
                        maybe_job = message["params"].as_array().cloned();
                        if let (true, Some(params)) = (new_tip, maybe_last_submit.take()) {
                            send(&mut writer, json!({"id": next_id, "method": "mining.submit", "params": params})).await?;
                            next_id += 1;
                        }
                    }
                    (Some(_), None) => {
                        let counter = if message["result"] == Value::Bool(true) {
                            &stats.accepted
                        } else if message["error"][0].as_u64() == Some(JOB_NOT_FOUND) {
                            &stats.stale_answered
                        } else {
                            &stats.rejected
                        };
                        counter.fetch_add(1, Ordering::Relaxed);
                    }
                    _ => {}
                }
            }
            _ = tick.tick() => {
                let (true, Some(mask), Some(subscription), Some(difficulty), Some(job)) =
                    (authorized, maybe_version_mask, &maybe_subscription, maybe_difficulty, &maybe_job)
                else {
                    continue;
                };
                extranonce_counter += 1;
                let extranonce2 = counter_hex(extranonce_counter, subscription.extranonce2_bytes);
                let target = target_from_difficulty(difficulty);
                let (version, version_bits) = rolled_version(job, mask)?;
                let Some((ntime, nonce)) =
                    solve(job, &version, &subscription.extranonce1, &extranonce2, target)?
                else {
                    continue;
                };
                let params = json!([username, job[0], extranonce2, ntime, nonce, version_bits]);
                send(&mut writer, json!({"id": next_id, "method": "mining.submit", "params": params})).await?;
                maybe_last_submit = Some(params);
                next_id += 1;
                stats.submitted.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

fn version_mask(message: &Value) -> MinerResult<u32> {
    if message["result"]["version-rolling"] != Value::Bool(true) {
        return Err("the pool did not grant version rolling".into());
    }
    let mask = message["result"]["version-rolling.mask"]
        .as_str()
        .ok_or("configure result needs a version mask")?;
    Ok(u32::from_str_radix(mask, 16)?)
}

/// Sets the lowest bit the mask grants, so every share's header differs from the job's.
/// Returns the rolled header version and, as the board sends them, the bits that
/// differ from the job's version.
fn rolled_version(job: &[Value], mask: u32) -> MinerResult<(String, String)> {
    let version = u32::from_str_radix(
        job.get(5)
            .and_then(Value::as_str)
            .ok_or("notify field 5 must be a string")?,
        16,
    )?;
    let lowest_granted_bit = mask & mask.wrapping_neg();
    if lowest_granted_bit == 0 {
        return Err("the pool granted an empty version mask".into());
    }
    let rolled = (version & !mask) | lowest_granted_bit;
    Ok((format!("{rolled:08x}"), format!("{:08x}", rolled ^ version)))
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
    version: &str,
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
    prefix.extend(reversed(version)?);
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
