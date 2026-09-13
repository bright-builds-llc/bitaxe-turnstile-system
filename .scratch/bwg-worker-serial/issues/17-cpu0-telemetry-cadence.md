# CPU0 telemetry cadence qualification support

Type: task
Status: resolved
Blocked by: None

## Objective

Implement Gate's typed, possession-bound cadence commands and dedicated acceptance
configuration under the firmware-owned prospective CPU0 cadence contract. Keep
endpoint information private, preserve old recovery/normal acceptance behavior,
and make actual normal-work heartbeat suppression bounded and one-use. Firmware
and its supervisor own hardware effects, ledger allowance and final judgments.

## Plan

- [x] Add closed cadence metadata and private endpoint parsers and controller methods.
- [x] Add exclusive cadence configuration, serialized USB phase receipts and work timer.
- [x] Test malformed metadata, admission, privacy, timing and mode isolation.
- [x] Record verification and publication requirements without claiming hardware proof.

## Comments

2026-09-13: Read local AGENTS, Bright Builds sidecar/overrides, architecture, code
shape, verification, testing and TypeScript standards; global and repository
active lessons total 9,369 bytes, loaded completely. Main matches origin/main.
The root task's contract fixes 60-second phases, 12 maximum probes, normal180000-ms
reservation and independent shutdown after heartbeat suppression. No hardware
work is performed from this Gate implementation task.

## Answer

Implemented typed arm/review/endpoint commands, strict metadata parsers, dedicated
sticky cadence mode, twelve serialized maximum probes and actual-work timing.
The mining timer allows the fixed sixty-second capture plus a two-second boundary
iteration tail, captures the existing private post-work authorization checkpoint,
and then suppresses only application heartbeats. Fresh reconnect compares that
checkpoint; the immutable pre-work baseline is never reset.

The private endpoint handoff reuses only the exact proof from the immediately
preceding budget review, checks its binding and age at most five seconds and
consumes the cached page authorization context. This avoids changing the control
binding through another possession challenge between host admission and handoff.
Endpoint/IP/binding metadata is never retained in public page state or traces.

Focused adapter, cadence, privacy, mode, transport, recovery and preservation
checks passed: 80 tests, plus TypeScript, standards and the acceptance-bundle
build. The first test run exposed a test-only request-log assumption (the harness
retains commands, not request IDs), corrected before the final run. New fixtures
also received their proper discriminated status shapes before typecheck passed.
No production threshold was relaxed. Small cadence owner/page modules keep the
controller and acceptance entrypoints within the existing file-size limit.

Full canonical Gate verification subsequently passed in the fresh ignored
`artifacts/cadence-qualification-20260913/cargo-target`: 352 Rust tests passed,
two existing opt-in tests ignored; 543 web/crypto tests and 1482 expectations
passed, as did browser conformance, lookup vectors, package verification and
standards. Clippy/build/test profiles used debug=0. No host stall or assertion
failure occurred in that full run. Logs are retained under the same artifact
parent. Fractional browser timing is normalized at the integer-millisecond
observation boundary and covered by realistic regressions.

The final firmware-owned USB witness amendment adds required `maxProbeCount`,
`firstMaxProbeAtUs` and `lastMaxProbeAtUs` fields. After the full run, its exact
Gate parser/fixtures passed 51 focused tests, final TypeScript and full browser
build; an additional omission regression passed in the final wire test log.
No Cargo source changed after the ordered Rust checks. The firmware parent owns
exact clean publication/package pinning and all hardware runs. This software
completion neither claims hardware cadence nor changes historical normal/recovery
judges.

Final publication verification reran the complete web/crypto suite after the
required maximum-probe witness fields: 544 tests and 1485 expectations passed.
The owner-approved formatter with GFM/frontmatter extensions checked only this
new ticket and the appended protocol/map sections, preserving all historical
prefix bytes. No Cargo source changed after the ordered native verification.
