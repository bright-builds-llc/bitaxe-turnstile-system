# 23: Prove Work Lease restoration on real Bitaxe hardware

**What to build:** Real Bitaxe evidence proves that bounded mainnet-capable challenge work can run through Reference Firmware and restore the exact Mining Baseline across every terminal and interruption path.

**Blocked by:** 18: Admit only exact BIP 23-valid mainnet jobs; 20: Aggregate Workers and fail over equivalent Pool Offers; 22: Onboard Bitaxe with settings-preserving Reference Firmware; child effort `bwg-worker-serial` Ticket 01 and firmware hardware qualification.

**Status:** ready-for-agent

- [x] The firmware repository consumes the shared Controller 0.4, Worker Serial 0.2, Local Device
  Possession, and Work Lease Authorization conformance profiles and fixtures, separate authority
  trust configurations, and exact signed Ultra 205 capability artifact.
- [x] Exact-device admission and safe hardware state are proven before each effectful attempt.
- [x] Completion, Pause, terminal Cancel, expiry, disconnect, reboot, and uncertain-time cases each end challenge mining.
- [x] Mining Baseline restoration is independently confirmed without exposing Wi-Fi or pool credentials.
- [x] Challenge credentials never persist as ordinary pool configuration.
- [x] Previously accepted Work Lease authorizations remain rejected across restoration and reboot
  using metadata-only durable per-key sequence state.
- [ ] Withheld, expired-context, and cross-possession Work Lease authorizations fail before mining;
  only the privacy-safe control-session digest reaches the Gate Authority.
- [ ] The same possession request answered by another Device Identity derives a different context
  and cannot reuse the first Worker's authorization.
- [ ] Mainnet use follows the established per-job BIP 23 and Reward Policy guardrails rather than a regtest stage gate.
- [x] Evidence records source identity, commands, safety, privacy, cleanup, outcome, and residual risks through the firmware repository's native workflow.

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

## BWG-007 serial restoration evidence — 2026-10-10

Firmware `8e16961bf3553e8b61c27531207fad8bee3bb609` with this repository at
`be55781d73d9ea190a8fc5c83ec69dac9557d83d` passed the firmware repository's
eight-scenario serial restoration campaign (BWG-007 attempt 009). An
independent review agrees with caveats. The firmware repository owns the
physical evidence:

- [measured closure summary](https://github.com/bright-builds-llc/bitaxe-esp-miner/blob/5c74db19/docs/parity/evidence/20261010-bwg007-restoration-closure.md);
- the first passing run, [attempt 008](https://github.com/bright-builds-llc/bitaxe-esp-miner/blob/5c74db19/docs/parity/evidence/20261009-bwg007-serial-restoration.md);
- per-scenario projections `bwg007-attempt-009-*.json` (profile 0.3) under
  [`bwg-worker-restoration/`](https://github.com/bright-builds-llc/bitaxe-esp-miner/blob/5c74db19/docs/parity/evidence/bwg-worker-restoration/);
- campaign design in
  [ADR-0035](https://github.com/bright-builds-llc/bitaxe-esp-miner/blob/5c74db19/docs/adr/0035-serial-bwg-restoration-campaign.md) and
  [ADR-0036](https://github.com/bright-builds-llc/bitaxe-esp-miner/blob/5c74db19/docs/adr/0036-measured-bwg-restoration-closure-facts.md).

| Acceptance item | Status | Evidence |
| --- | --- | --- |
| Shared profiles, fixtures, trust and signed Ultra 205 capability consumed | resolved | Pinned Gate conformance tests in the firmware repository; preflight admits trust, page and bundle digests |
| Exact-device admission and safe state before each effect | resolved | Detector, `board-info` and preflight before every attempt; settle gate idle or complete before every signing |
| Completion, Pause, Cancel, expiry, disconnect, reboot, uncertain time end mining | resolved | All eight scenarios passed, including the in-process `monotonic_reset` stimulus |
| Baseline restoration confirmed without exposing credentials | resolved | Baseline confirmed per scenario; seal-time credential scan 0 hits; independent review |
| Challenge credentials never persist as pool configuration | resolved, per boot | `worker-preservation-v2` reported pool configuration unchanged in all 54 statuses; cross-boot equality and identical-value writes are not distinguishable |
| Accepted authorizations stay rejected across restoration and reboot | resolved | N1 durable replay after reboot and N4 in-context renewal replay, attributed to the durable high-water |
| Withheld, expired-context and cross-possession authorizations fail before mining | partly resolved | Expired context (N2) and cross-possession (N3) rejected before mining; the withheld case was not separately exercised |
| Another Device Identity derives a different context | open | Not covered by BWG-007; needs Gate conformance evidence |
| Mainnet use follows the per-job BIP 23 and Reward Policy guardrails | open | Not evidenced by BWG-007 |
| Evidence records identity, commands, safety, privacy, cleanup, outcome, residual risks | resolved | Firmware task record and evidence summaries |

Caveats carried from the review:

- `reboot` is not shown to be a power-on reset.
- N4's `control_failed` stop is established by code, not observed.
- Live safety limits and pool shares are not judged.
- The device-identity tracker is page-local to this repository's restoration page.

This ticket stays open until the withheld-authorization, other-identity and
BIP 23 items resolve, and until its blockers 18, 20 and 22 are evidenced.
