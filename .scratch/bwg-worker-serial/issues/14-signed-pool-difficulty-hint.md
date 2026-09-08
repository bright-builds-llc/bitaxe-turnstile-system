# 14: Bind Worker pool difficulty hints to signed grants

Status: resolved
Blocked by: None
Type: task

- [x] Add bounded optional signed `stratum.suggestedDifficulty`, preserving omitted versus zero.
- [x] Advertise the required profile through the signed serial application manifest.
- [x] Regenerate public capability/possession fixtures and add cross-language RFC8032 hint vectors.
- [x] Test invalid values, signature tampering, old manifest rejection and private stdin signing.
- [x] Complete repository verification.
- [x] Complete coordinated Gate publication / firmware pin.
- [x] Re-sign the deployment capability through its existing protected Update Authority.
- [x] Record bounded owner-pool hardware acceptance through the firmware-owned qualification workflow.

## Comments

The implementation follows [ADR 0100](../../../docs/adr/0100-bind-worker-pool-difficulty-hints.md).
The firmware harness owns the public `--suggested-difficulty 1000` option. Gate's
existing `sign-start` command accepts the hint in its in-memory Start JSON; no
extra credential-file editing path or installed helper is introduced. Software
verification does not resolve the still-open real share acceptance criterion.

The firmware deployment capability was signed and verified against unchanged
deployment trust. Public conformance keys remain fixture-only. Format, lint,
type/build, 417 JavaScript tests, browser conformance, lookup, package and
standards passed. A lifecycle streaming-test timeout passed on isolated and
whole-group reruns without source or timeout changes. A later test binary
stalled before main in `_dyld_start`; its exact owned process was terminated and
reaped. Full Rust verification is continuing with the default debug-info profile.

Full default-profile Rust verification passed: 352 tests, two existing opt-in
tests ignored. The complete check set is now green across the recorded runs.
No source or deadline workaround was introduced for host timing or launch
delays. Firmware publication and fresh bounded hardware evidence remain pending.


## Answer

Completed on 2026-09-08. The signed hint was consumed by the exact published
runtime pair: Gate `2106f1c1587025d0570e058647a29492159e5d20`, firmware
`f3bbfd6a05abcffa3735a736c87ff0c250ab8e2a`, and ELF SHA-256
`77ccb176a50f5d973fe99bb3c277ff456a70852f3eb4a0d8d64d02bb23ce9433`.
Host qualification driver `88ddb8a507477faa9220588d6ecf1f6de27fd754` retained
those runtime artifacts while handling the unreserved authorization continuation.

The normal run produced five correlated qualified candidates, five submissions
and five accepted shares, with three acknowledged renewals and 59,069 ms active.
Foreground loss closed admission in 2,807 ms and initiated shutdown in 2,821 ms;
heartbeat loss measured 2,805 ms and 2,826 ms respectively. Their active durations
were 10,510 ms and 14,020 ms; the heartbeat run also recorded one accepted share and one acknowledged renewal.
These measurements satisfy the bounded acceptance cases, not every restoration
or hardware-parity requirement in Core Ticket 23.

The iterative ledger ended at 1,140,000 ms charged, next ordinal 14, with no pending
reservation. Charged allowance is not a measurement of actual mining duration.
The original 240,000-ms campaign remained unchanged. Final evidence records mining
on boot disabled, 28°C, 30% fan at 3,178 RPM, 0.44 W at 5.4775 V, and released
browser, supervisor and USB resources.

A stale complete device-to-host frame can still prevent a fresh Hello; the
qualified receive-only drain is a bounded recovery step, not proof of seamless
reconnection. No pool credentials or endpoint details are included here, and no
unrelated parity or BIP 23 blocker is promoted.

See the [firmware acceptance report](https://github.com/bright-builds-llc/bitaxe-esp-miner/blob/dc68c5ec/docs/parity/evidence/20260908-worker-preparation-live-acceptance.md) for the retained attempts,
identities, safety observations and cleanup evidence.
