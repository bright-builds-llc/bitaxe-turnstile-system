# 07: Prove cross-repository restoration and close the parent

**What to build:** Compose the production Reference Client, Controller 0.3 transport, Reference
Firmware, local mainnet-shaped pool path, and native hardware evidence into one bounded Ultra 205
restoration proof that closes BWG Core Ticket 23.

**Blocked by:** 04: Add the production Reference Client WebUSB adapter;
06: Implement the Reference Firmware composite USB adapter.

**Status:** resolved

- [ ] Exact device, source, reference, package, transport functions, safe baseline, protected root,
  and recovery artifacts pass the firmware repository's no-effect preflight before each scenario.
- [ ] Completion, Pause, terminal Cancel, exclusive expiry, control disconnect, reboot, and
  uncertain monotonic continuity each end challenge mining and independently confirm the exact
  Mining Baseline.
- [ ] Challenge credentials are confined to bounded authenticated control transfers and volatile
  firmware memory; they never persist as ordinary pool configuration and are absent from CDC
  evidence, logs, telemetry, manifests, task/command records, browser-visible or public state, and
  committed projections.
- [ ] Replaying any previously accepted Start or Renew authorization before, after, or across a
  reboot remains rejected by the persisted per-key authorization-sequence high-water mark without
  replaying challenge work.
- [ ] A withheld Start authorization, a token from a prior possession context, and a token presented
  after the 60-second local context window are rejected before any Production Mining Session
  effect; Resume obtains a fresh possession-derived context without publishing Device Identity.
- [ ] Replaying the same possession request against another Device Identity produces a different
  control-session digest and cannot reuse the first Worker's authorization.
- [ ] Mainnet-capable jobs traverse the established per-job BIP 23 and Reward Policy guardrails;
  no regtest-only stage gate substitutes for those checks.
- [ ] Every hardware attempt uses one immutable protected root, earliest typed failure,
  deterministic cleanup/restoration, independent redaction validation, and a closed terminal
  outcome under the firmware repository's native workflow.
- [ ] Cross-repository package/version/digest evidence proves the firmware consumed the exact
  published Controller 0.3, Worker USB 0.2, Local Device Possession, and Work Lease Authorization
  profiles and fixtures, the separate authority trust configurations, and the signed Ultra 205
  capability artifact bound to the exercised descriptor.
- [ ] The accepted redacted evidence is linked from and resolves every acceptance item in BWG Core
  Ticket 23; unresolved boundaries remain explicit non-claims.

## Answer

Pending.

## Superseded — 2026-09-04

Closed without claiming hardware verification. The approved fixed Serial/JTAG task replaces this active implementation: `.scratch/bwg-worker-serial/issues/01-fixed-serial-worker.md`. Earlier checked evidence remains historical.
