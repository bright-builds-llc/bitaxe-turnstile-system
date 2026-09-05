# 03: Preserve admission failure evidence across asynchronous closure

**Status:** resolved
**Blocked by:** None

- [x] Reproduce a transport-triggered close that hides the current admission stage.
- [x] Keep a separate admission identity through closure, while isolating later connections.
- [x] Report only allowlisted serial failure categories and Worker/network diagnostics.
- [x] Complete verification and prepare the exact revision for publication and firmware pinning.

## Context

The physical device now emits exact runtime identity and startup observations, but an asynchronous disconnect during admission increments the lifecycle generation before the admission catch runs. This suppresses its stage report. Keep cleanup and stale-session protections while preserving the first failure of the current admission attempt. Do not retain raw requests, proofs, identity fingerprints, credentials, or arbitrary exception strings.

## Review

The actual asynchronous reader failure first reproduced a missing `hello` stage, then reproduced retained origin ownership despite successful native port closure. Both regressions now pass. Admission identity remains separate from lifecycle cancellation, so an older attempt cannot overwrite a later attempt. Typed local errors are mapped to a closed observation vocabulary; arbitrary exception text and forged category objects produce only a generic category.

The port owner retains the native close promise beyond caller timeout. Confirmed closure releases ownership even when earlier stream cleanup reports an error; pending or failed native closure retains it. The original failure remains visible. Late native closure, existing controller behavior, and strict network diagnostic grammar tests pass. Firmware owns actual peer-heartbeat transmission and hardware qualification.

Verification: `bun run format` and `RUST_TEST_THREADS=1 bun run verify` pass, including Rust, TypeScript, production bundles, all 295 web/CLI tests, browser conformance, package exports, and standards. The earlier parallel Rust run failed during PostgreSQL container setup before the test body; the serialized full run passed without changing deadlines or assertions. Firmware hardware qualification remains pending.
