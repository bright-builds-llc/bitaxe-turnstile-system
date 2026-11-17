//! The Pool Adapter's opt-in retention sweep: whether it runs, and the task that runs it.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::{PostgresPoolAdapterRetention, StratumV1Error};
use crate::governance::HOSTED_OPERATIONAL_RETENTION_SECONDS;

const MINIMUM_INTERVAL_SECONDS: u64 = 60;
const MAXIMUM_INTERVAL_SECONDS: u64 = 86_400;
const SWEEP_BATCH_ROWS: u64 = 1_000;

/// Whether the Pool Adapter deletes its own expired records, and how.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PoolAdapterRetentionSweep {
    /// Expired records stay until the operator deletes them.
    Off(SweepOffReason),
    /// Every `interval`, delete records older than `retention_seconds` past their end.
    On {
        interval: Duration,
        retention_seconds: u64,
    },
}

/// Why the sweep is off.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SweepOffReason {
    /// No interval is set.
    IntervalUnset,
    /// An interval is set, but destructive governance isn't enabled.
    DestructiveDisabled,
}

impl PoolAdapterRetentionSweep {
    /// Decides the sweep from its settings, refusing any set value that is malformed or
    /// out of range, whether or not the sweep would run.
    pub fn from_settings(
        maybe_interval: Option<&str>,
        maybe_retention: Option<&str>,
        destructive_enabled: bool,
    ) -> Result<Self, StratumV1Error> {
        let retention_seconds = match maybe_retention {
            Some(value) => parse_seconds(value)?,
            None => HOSTED_OPERATIONAL_RETENTION_SECONDS,
        };
        if retention_seconds < HOSTED_OPERATIONAL_RETENTION_SECONDS {
            return Err(StratumV1Error::InvalidRetentionPolicy);
        }
        let Some(interval) = maybe_interval else {
            return Ok(Self::Off(SweepOffReason::IntervalUnset));
        };
        let interval_seconds = parse_seconds(interval)?;
        if !(MINIMUM_INTERVAL_SECONDS..=MAXIMUM_INTERVAL_SECONDS).contains(&interval_seconds) {
            return Err(StratumV1Error::InvalidRetentionPolicy);
        }
        if !destructive_enabled {
            return Ok(Self::Off(SweepOffReason::DestructiveDisabled));
        }
        Ok(Self::On {
            interval: Duration::from_secs(interval_seconds),
            retention_seconds,
        })
    }
}

fn parse_seconds(value: &str) -> Result<u64, StratumV1Error> {
    value
        .parse()
        .map_err(|_| StratumV1Error::InvalidRetentionPolicy)
}

/// Deletes expired records every `interval`, the first run at once, until dropped.
///
/// A failed run is logged and the next one tries again, so one bad run never stops the
/// process.
pub(super) async fn sweep_expired_records(
    retention: PostgresPoolAdapterRetention,
    interval: Duration,
    retention_seconds: u64,
) {
    let mut ticks = tokio::time::interval(interval);
    loop {
        ticks.tick().await;
        let Ok(elapsed) = SystemTime::now().duration_since(UNIX_EPOCH) else {
            tracing::error!("system clock is unavailable to the retention sweep");
            continue;
        };
        match retention
            .retire_until_done(elapsed.as_secs(), retention_seconds, SWEEP_BATCH_ROWS)
            .await
        {
            Ok(counts) if counts.is_empty() => {}
            Ok(counts) => tracing::info!(
                connections = counts.connections,
                sessions = counts.sessions,
                settled_events = counts.settled_events,
                "expired Pool Adapter records deleted"
            ),
            Err(error) => tracing::warn!(%error, "Pool Adapter retention sweep failed"),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{PoolAdapterRetentionSweep, SweepOffReason};
    use crate::{governance::HOSTED_OPERATIONAL_RETENTION_SECONDS, stratum_v1::StratumV1Error};

    fn floor_plus(seconds: i64) -> String {
        (HOSTED_OPERATIONAL_RETENTION_SECONDS as i64 + seconds).to_string()
    }

    #[test]
    fn an_unset_interval_leaves_the_sweep_off() {
        let sweep = PoolAdapterRetentionSweep::from_settings(None, None, true);

        assert!(matches!(
            sweep,
            Ok(PoolAdapterRetentionSweep::Off(
                SweepOffReason::IntervalUnset
            ))
        ));
    }

    #[test]
    fn an_interval_without_the_destructive_switch_leaves_the_sweep_off() {
        let sweep = PoolAdapterRetentionSweep::from_settings(Some("60"), None, false);

        assert!(matches!(
            sweep,
            Ok(PoolAdapterRetentionSweep::Off(
                SweepOffReason::DestructiveDisabled
            ))
        ));
    }

    #[test]
    fn the_interval_bounds_turn_the_sweep_on_at_the_floor() -> Result<(), StratumV1Error> {
        for (setting, seconds) in [("60", 60), ("86400", 86_400)] {
            let sweep = PoolAdapterRetentionSweep::from_settings(Some(setting), None, true)?;

            assert_eq!(
                sweep,
                PoolAdapterRetentionSweep::On {
                    interval: Duration::from_secs(seconds),
                    retention_seconds: HOSTED_OPERATIONAL_RETENTION_SECONDS,
                }
            );
        }
        Ok(())
    }

    #[test]
    fn an_interval_outside_its_bounds_or_not_a_number_is_refused() {
        for setting in ["59", "86401", "0", "ten", ""] {
            let sweep = PoolAdapterRetentionSweep::from_settings(Some(setting), None, true);

            assert!(
                matches!(sweep, Err(StratumV1Error::InvalidRetentionPolicy)),
                "{setting:?} must be refused"
            );
        }
    }

    #[test]
    fn a_period_under_the_floor_is_refused_even_with_the_sweep_off() {
        let short = floor_plus(-1);

        let sweep = PoolAdapterRetentionSweep::from_settings(None, Some(&short), false);

        assert!(matches!(sweep, Err(StratumV1Error::InvalidRetentionPolicy)));
    }

    #[test]
    fn a_longer_period_is_carried_through() -> Result<(), StratumV1Error> {
        let longer = floor_plus(1);

        let sweep = PoolAdapterRetentionSweep::from_settings(Some("3600"), Some(&longer), true)?;

        assert_eq!(
            sweep,
            PoolAdapterRetentionSweep::On {
                interval: Duration::from_secs(3_600),
                retention_seconds: HOSTED_OPERATIONAL_RETENTION_SECONDS + 1,
            }
        );
        Ok(())
    }
}
