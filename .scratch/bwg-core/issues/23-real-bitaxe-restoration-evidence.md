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
- [ ] Complete coordinated exact-commit firmware consumption.
- [ ] Obtain any outstanding physical receive/share evidence within the existing authorized budget; software observations do not establish it.

The codec, conformance definition and [protocol description](../../../docs/protocol/worker-mining-progress-v1.md)
record the new optional field. Hardware acceptance and unresolved parity blockers remain open.

Verification: format, lint, type checking, build, 352 Rust tests, 404 JavaScript tests, headless browser checks, lookup vectors, package and standards checks passed. The browser fixture now builds its exact target before the existing server-readiness timer and inherits the caller's Cargo profile; startup limits are unchanged. Hardware evidence remains pending.

## Fixed-filter discriminator

- [x] Parse closed mining-progress v2 while preserving v1 history and excluding raw candidate and pool data.
- [x] Verify the fixed-filter extension.
- [ ] Complete exact published firmware consumption.
- [ ] Obtain physical accepted-share and outstanding stop evidence; parsed below-target nonces alone do not establish reconstructed-hash quality.

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
