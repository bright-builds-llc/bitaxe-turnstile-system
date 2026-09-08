# 23: Prove Work Lease restoration on real Bitaxe hardware

**What to build:** Real Bitaxe evidence proves that bounded mainnet-capable challenge work can run through Reference Firmware and restore the exact Mining Baseline across every terminal and interruption path.

**Blocked by:** 18: Admit only exact BIP 23-valid mainnet jobs; 20: Aggregate Workers and fail over equivalent Pool Offers; 22: Onboard Bitaxe with settings-preserving Reference Firmware; child effort `bwg-worker-serial` Ticket 01 and firmware hardware qualification.

**Status:** ready-for-agent

- [ ] The firmware repository consumes the shared Controller 0.4, Worker Serial 0.2, Local Device
  Possession, and Work Lease Authorization conformance profiles and fixtures, separate authority
  trust configurations, and exact signed Ultra 205 capability artifact.
- [ ] Exact-device admission and safe hardware state are proven before each effectful attempt.
- [ ] Completion, Pause, terminal Cancel, expiry, disconnect, reboot, and uncertain-time cases each end challenge mining.
- [ ] Mining Baseline restoration is independently confirmed without exposing Wi-Fi or pool credentials.
- [ ] Challenge credentials never persist as ordinary pool configuration.
- [ ] Previously accepted Work Lease authorizations remain rejected across restoration and reboot
  using metadata-only durable per-key sequence state.
- [ ] Withheld, expired-context, and cross-possession Work Lease authorizations fail before mining;
  only the privacy-safe control-session digest reaches the Gate Authority.
- [ ] The same possession request answered by another Device Identity derives a different context
  and cannot reuse the first Worker's authorization.
- [ ] Mainnet use follows the established per-job BIP 23 and Reward Policy guardrails rather than a regtest stage gate.
- [ ] Evidence records source identity, commands, safety, privacy, cleanup, outcome, and residual risks through the firmware repository's native workflow.

## Transport prerequisite

[`bwg-worker-serial`](../../bwg-worker-serial/spec.md) must first publish and compose
the fixed Serial/JTAG session and typed control/evidence profiles. Ticket 23 consumes that child effort's exact
Controller 0.4, Worker Serial 0.2, Local Device Possession, and Work Lease Authorization fixtures,
separate authority trust configurations, signed Ultra 205 capability, Reference Client adapter,
Reference Firmware adapter, and cross-repository hardware evidence. It does not send Work Lease
commands over the unframed runtime log transport.


## Mining progress diagnostics

- [x] Add optional closed `worker-mining-progress-v1` observations, keeping historical absence valid.
- [x] Separate parsed nonce, below-target, qualified-candidate, discard and blocked-correlation counts without raw job or pool data.
- [x] Preserve the legacy `nonce_work_correlations` meaning; the new counters authorize no work and add no shutdown requirement.
- [x] Complete repository verification.
- [x] Complete coordinated exact-commit firmware consumption.
- [x] Record physical nonce/share and bounded foreground-loss/heartbeat-loss evidence; broader restoration obligations above remain open.

The codec, conformance definition and [protocol description](../../../docs/protocol/worker-mining-progress-v1.md)
record the new optional field. Hardware acceptance and unresolved parity blockers remain open.

Verification: format, lint, type checking, build, 352 Rust tests, 404 JavaScript tests, headless browser checks, lookup vectors, package and standards checks passed. The browser fixture now builds its exact target before the existing server-readiness timer and inherits the caller's Cargo profile; startup limits are unchanged. Hardware evidence remains pending.

## Fixed-filter discriminator

- [x] Parse closed mining-progress v2 while preserving v1 history and excluding raw candidate and pool data.
- [x] Verify the fixed-filter extension.
- [x] Complete exact published firmware consumption.
- [x] Obtain correlated accepted-share and bounded foreground-loss/heartbeat-loss evidence; no broader parity claim follows from these cases.

The new counters compare reconstructed hashes against the explicit software
model in [mining-progress v2](../../../docs/protocol/worker-mining-progress-v2.md).
They do not change pool settings, target qualification, or safety gates.

Fixed-filter verification: 352 Rust tests, 407 JavaScript tests, type/build, headless browser, lookup vectors, package and standards checks passed. The retention test now timestamps claimant proofs at each lookup and explicitly proves stale-proof rejection; production authentication and retention limits are unchanged.

The version-2 diagnostic harness now stops at the first reconstructed candidate
classification, retaining the existing 30-second allowance and shutdown reserve.
It does not wait for an accepted share; missing classification remains missing
evidence. Normal acceptance and fault-window durations are unchanged.

Diagnostic-stop verification passed: 352 Rust tests (two existing opt-in tests
ignored), 411 JavaScript tests, formatting, lint, type/build, browser conformance,
lookup vectors, package and standards. Transient PostgreSQL fixture EOF failures
did not recur in an observed six-test rerun or the full suite. A proposed
readiness change was disproved and reverted; no fixture workaround remains.


## Bounded hardware acceptance — 2026-09-08

The shared mining-progress profiles, fixed-filter discriminator and signed
pool-difficulty hint were consumed by Gate
`2106f1c1587025d0570e058647a29492159e5d20`, firmware
`f3bbfd6a05abcffa3735a736c87ff0c250ab8e2a`, and ELF SHA-256
`77ccb176a50f5d973fe99bb3c277ff456a70852f3eb4a0d8d64d02bb23ce9433`.
Qualification driver `88ddb8a507477faa9220588d6ecf1f6de27fd754` changed host
orchestration while preserving that exact runtime pair.

| Case | Active duration | Recorded outcome |
| --- | --- | --- |
| Normal ordinal 11 | 59,069 ms | Five qualified candidates, five submitted/accepted shares, three acknowledged renewals |
| Foreground ordinal 12 continuation | 10,510 ms | Gate closure 2,807 ms; shutdown initiation 2,821 ms |
| Heartbeat-loss ordinal 13 | 14,020 ms | Gate closure 2,805 ms; shutdown initiation 2,826 ms; one accepted share and one acknowledged renewal |

The earlier expired-possession delivery for ordinal 12 remained unreserved and
unverified; its records were preserved by an explicit continuation rather than
promoted or refunded. The final iterative ledger reports 1,140,000 ms charged,
next ordinal 14 and no pending reservation; the original 240,000-ms campaign is
unchanged. Final cleanup records mining on boot disabled, 28°C, 30% fan at
3,178 RPM, 0.44 W at 5.4775 V, and released browser, supervisor and USB resources.

The [firmware acceptance report](https://github.com/bright-builds-llc/bitaxe-esp-miner/blob/dc68c5ec/docs/parity/evidence/20260908-worker-preparation-live-acceptance.md) owns the physical evidence. This
closes the narrow consumption/share/timing items in the two diagnostic sections
above. Ticket 23 remains open: its BIP 23, aggregation/onboarding dependencies and
full terminal/interruption restoration matrix have not been established by these
runs. Stale complete device-to-host frames still require a bounded receive-only
drain before some fresh Hello attempts; seamless recovery is not claimed. No
unrelated mining, Stratum or hardware-parity blocker is promoted.
