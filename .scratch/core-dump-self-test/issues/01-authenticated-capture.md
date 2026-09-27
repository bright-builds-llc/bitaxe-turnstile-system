# Authenticated development core-dump self-test

Status: resolved
Blocked by: None

The firmware diagnostic task owns all device effects. This change adds only a
capability-gated browser command and validates its authenticated reset lifecycle.
Ordinary restart retains its software-reset contract. No device access occurs here.

- [x] Add distinct self-test wire command/ACK and panic reset observation.
- [x] Add explicit configuration capability and page operation, preserving the
  existing same-page before/candidate identity and preservation checks.
- [x] Test wire admission, one-use, panic versus software reset and cleanup.
- [x] Run repository verification; review diff; publish when coordinator is ready.

## Answer

Implemented distinct authenticated core-dump self-test and panic-reset observation
through the existing bounded owner lifecycle. Explicit before-phase V2 reads
retain exact identity and reject effects; the native page preserves its private
baseline and one-use claim across candidate reconnects. Ordinary restart still
requires software reset. No device access occurred.

Verification: `bun run verify` passed (799 web/conformance tests, Rust tests,
browser conformance, build, typecheck, Clippy, package and standards checks).
The focused 38-test suite, Markdown checks and diff checks also passed. The
central serial adapter remains intentionally cohesive at 629 lines; its exact
checker exception records the ownership rationale. Capture success and firmware
physical-off safety remain the firmware task's hardware evidence obligations.
