# 02: Diagnose admission and retain ownership through late serial opening

**Status:** resolved
**Blocked by:** None

- [x] Report only closed qualification admission stages; never expose caught errors, keys, or payloads.
- [x] Retain the selected port and origin lock until an in-flight open settles and cleanup succeeds.
- [x] Prove late-open timeout/cancellation cleanup, concurrent-admission isolation, and stage reporting.
- [x] Display only allowlisted startup observations in the local browser, separately from authority and supervisor evidence.
- [x] Run required checks and prepare the verified revision for publication and exact consumer pinning.

## Context

The firmware-owned no-mining attempt selected the physical USB device but only reported `connect_failed`. No authenticated application session or mining was established. Source inspection also found that `port.open()` can time out before the channel owns the raw port. A later successful open could therefore escape cleanup. This follow-up preserves the failed attempt and adds verified observability before another hardware attempt; it does not authorize hardware effects.

## Review

The port owner is a separate resource-lifetime boundary so native open, channel attachment, cancellation, and actual release share one owner. The controller retains protocol admission; the extracted hello validator preserves the existing contract. Startup diagnostics accept only closed producer grammars and never establish identity, extend heartbeats, enter backend records, or expose arbitrary payload text. Nineteen focused tests cover admission, ownership, framing, and existing controller behavior. Hardware qualification remains in the firmware repository.

Verification: `bun run format` and full `bun run verify` pass, including ordered Rust lint/build/tests, TypeScript, production bundles, all 291 web/CLI tests, real-browser conformance, package exports, and standards. The firmware consumer must pin this published commit and archive digest before its next hardware attempt.
