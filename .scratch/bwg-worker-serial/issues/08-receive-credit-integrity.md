# 08: Bound native receive progress and verify exact payloads

Status: resolved
Blocked by: None
Type: task

- [x] Implement ADR 0096 and serial 0.2 integrity, bounded receive credit and cancellation.
- [x] Preserve sequence order at actual dequeue and whole-record deadlines.
- [x] Preserve the first closed probe/write failure through wrappers.
- [x] Publish cross-language fixtures and retire active serial 0.1 exports.
- [x] Pass bounded-receiver, corruption, lifecycle, browser and repository checks.

## Context

Actual firmware received 1,792 fewer fixed-pattern bytes than the browser
prepared. The full-size response alone concealed that loss; the request-count
check rejected it. The stock receive driver can discard packets at a full ring,
and native browser write completion is not device consumption.

The canonical contract is `docs/protocol/bwg-worker-serial-0.2.md`. Keep all
firmware authority, safety, privacy and mining-budget constraints. Earlier
failed attempts and successful earlier-profile cycles remain their original
evidence. No hardware action is authorized by this Gate ticket.

## Answer

Implemented exact lexical payload integrity and cumulative receive credit with
the fixed 2048-byte window, 1024-byte chunks and whole-record deadline. Tests
reproduced uncredited overflow before the fix and verify delivery, final short
acknowledgements, counter boundaries, cancellation and bounded bootstrap recovery.
Hello admission is synchronous before subsequent same-batch frames; pending
response cancellation appends no new command. Existing authority and liveness
requirements remain.

Full verification passed: ordered Rust checks, TypeScript, production builds,
361 web/CLI tests, browser conformance, lookup vectors, package and standards.
Review findings on stale output, terminal Close and same-batch Hello were
resolved with combined regressions. An additional independent test launch that
stalled before test output was terminated and is not counted as verification.
Firmware still owns exact-package hardware qualification and mining evidence.
