# 07: Preserve the first closed controller rejection

**Status:** resolved
**Blocked by:** None

- [x] Accept exactly the firmware controller's closed error categories.
- [x] Retain the first failure per diagnostic category within a connection.
- [x] Clear diagnostic observations at fresh connection initiation.
- [x] Verify rejection of unknown categories, added text and authority claims.
- [x] Complete repository verification and publish the paired diagnostic client.

## Context

A bounded hardware Start attempt lost liveness after the firmware revoked its
logical session. The controller already emits a closed error category before
revocation, but the browser's diagnostic grammar drops that category. Preserve
the original attempt as failed; this change improves local observations only.
It does not grant work authority, alter the protocol, or prove delivery before
revocation.

## Verification

All twelve producer categories failed their browser regression before the grammar
change. The focused diagnostic, admission and framing suite then passed 36 tests.
The production controller fixture receives a fragmented raw rejection followed
by another rejection and arbitrary synthetic text; the first category survives
the subsequent 2800 ms liveness timeout and the port is closed and unlocked.
Type checking, managed standards and whitespace checks pass.

Full repository verification passes: ordered Rust checks, TypeScript, browser
builds and conformance, 316 web/CLI tests, lookup vectors, package and standards
checks. The browser fixture was built explicitly before its bounded startup
check; no deadline was changed. This resolves software observation handling,
with hardware delivery still subject to the firmware qualification task.

The bounded history retains the first failure per category and the latest normal
observation per stage. Fresh connection initiation clears only local diagnostics;
it does not reset the private preservation baseline or any device authority.
Hardware delivery and the original Start failure's cause remain unverified.
