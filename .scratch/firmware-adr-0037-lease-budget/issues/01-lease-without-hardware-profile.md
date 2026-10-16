# Retire the signed hardware profile and make the lease budget mining time

Type: task
Status: resolved
Blocked by: None

Requested by `bitaxe-esp-miner` `task-lease-without-hardware-profile` on
2026-10-16, in lockstep with firmware ADR-0037 (decisions 1 and 5 as amended).
Recorded as Gate ADR-0103.

- [x] Refuse `hardwareProfile` in the grant parser and the signer. Remove the
  profile clauses from the soak shape rule.
- [x] Soak allowance `worker-soak-allowance-v2` at exactly 600,000 ms, and the
  `worker-soak-ledger-v2` review charging 600,000 ms per ordinal. Refuse v1.
- [x] Add the firmware's 22,550 ms shutdown bound to the restoration deadlines
  (graceful restore response, soak backstop). Keep the existing cooling
  allowances.
- [x] Regenerate the soak conformance vectors with the public RFC 8032 key.
- [x] Update the tests, the protocol docs and the ADR.
- [x] Run `bun run verify`.

## Answer

The grant parser and signer now refuse `hardwareProfile`. A soak is a v2
allowance of exactly 600,000 ms of mining time. The v2 ledger starts fresh and
charges 600,000 ms per ordinal, and v1 allowances and ledgers are refused.

`web/worker-restoration-bound.ts` names the 22,550 ms shutdown bound. The
graceful restore response bound is now 152,000 ms: 3,000 ms initiation, plus
22,550 ms shutdown, plus 120,000 ms cooling, plus 6,450 ms transport. The soak
backstop is now 892,550 ms: 120,000 ms preparation, plus the 600,000 ms
budget, plus 22,550 ms shutdown, plus 150,000 ms safe-stop.

`conformance/bwg-worker-controller-0.4/soak-allowance-vectors.json` holds two
v2 grants (ordinals 1 and 2) without the profile. The firmware's copy
(`crates/bitaxe-worker-control/tests/authorization/gate-soak.json`) must be
refreshed from it.

`bun run verify` passed with exit 0. That covers Rust format, Clippy, build
and tests, typecheck, 1,109 web/conformance tests, browser conformance, the
package dry run and the standards checks (0 findings).

No device access occurred. Not committed: the coordinator owns the commit and
the pinned Gate commit in the firmware repository.

## Comments
