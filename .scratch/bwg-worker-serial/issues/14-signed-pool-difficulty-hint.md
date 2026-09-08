# 14: Bind Worker pool difficulty hints to signed grants

Status: claimed
Blocked by: None
Type: task

- [x] Add bounded optional signed `stratum.suggestedDifficulty`, preserving omitted versus zero.
- [x] Advertise the required profile through the signed serial application manifest.
- [x] Regenerate public capability/possession fixtures and add cross-language RFC8032 hint vectors.
- [x] Test invalid values, signature tampering, old manifest rejection and private stdin signing.
- [x] Complete repository verification.
- [ ] Complete coordinated Gate publication / firmware pin.
- [x] Re-sign the deployment capability through its existing protected Update Authority.
- [ ] Obtain any further hardware evidence through the firmware task and existing budget.

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
