//! Stratum version rolling (`mining.configure`) as Hydra applies it.

use serde_json::Value;

use super::StratumV1Error;

/// The mask a `mining.configure` reply grants, if it enabled version rolling.
pub(super) fn negotiated_version_mask(message: &serde_json::Map<String, Value>) -> Option<u32> {
    let result = message.get("result")?.as_object()?;
    if result.get("version-rolling").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let mask = result.get("version-rolling.mask")?.as_str()?;
    if mask.is_empty() || mask.len() > 8 || !mask.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    u32::from_str_radix(mask, 16).ok()
}

/// Applies a submit's version bits the way the Mining Pool does: the job's version
/// outside the negotiated mask, the submitted bits inside it.
pub(super) fn rolled_version(
    job_version: &str,
    bits: &Value,
    maybe_mask: Option<u32>,
) -> Result<String, StratumV1Error> {
    let mask = maybe_mask.ok_or(StratumV1Error::VersionRollingNotNegotiated)?;
    let parse = |hex: &str| {
        if hex.len() != 8 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(StratumV1Error::InvalidFrame);
        }
        u32::from_str_radix(hex, 16).map_err(|_| StratumV1Error::InvalidFrame)
    };
    let bits = parse(bits.as_str().ok_or(StratumV1Error::InvalidFrame)?)?;
    let version = parse(job_version)?;
    Ok(format!("{:08x}", (version & !mask) | (bits & mask)))
}
