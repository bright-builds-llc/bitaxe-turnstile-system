# Retain statistics startup diagnostics during controlled restart

Type: task
Status: resolved
Blocked by: None

## Objective

Retain the firmware owner's closed statistics-thread startup receipt and withhold
fresh Hello after a prepared receipt until activation is observed. Diagnostics
remain non-authoritative; no hardware, control authority or timeout changes.

## Plan

- [x] Parse the closed producer grammar with integer and availability bounds.
- [x] Preserve startup failures and gate prepared-to-active restart readiness.
- [x] Verify old-firmware compatibility and failure evidence through focused tests.
- [x] Document the producer ordering and hand off for canonical verification.
- [x] Complete container-backed Rust and headless verification before publication.

## Constraints

The stack remains 8192 bytes. Prepared, active and cancelled receipts have no
errno and retain numeric capabilities and all four heap measurements. Spawn
failure permits a signed raw OS errno or unavailable with numeric allocation
metadata. Configuration failure has unavailable errno, capabilities and heap
measurements. No raw error string is accepted. The producer repeats this receipt
before each corresponding USB startup status. Existing restart record, byte and
30-second time bounds remain unchanged. Exact-device proof belongs to the
firmware owner's prospective successor contract.

## Answer

The parser and protected restart observer now retain the closed statistics
receipt. Prepared state waits for post-boot active, including after a same-port
reopen. Spawn/configuration failure and cancellation latch failure while keeping
the original receipt. Ordinary diagnostic history also preserves the first
statistics failure if later activation observations arrive.

Verification: 59 focused parser, observer, actual-controller restart, owner and
page tests pass (235 assertions), including legacy firmware with no statistics
receipt. Full TypeScript checking and diff review pass. New tests failed before
the implementation for missing parsing, premature readiness and missing failure
rejection. Signed i32 errno bounds, u32 bounds, mixed/unavailable states, private
field rejection and frozen failure observations are covered. The implementation
keeps the existing parser grammar registry and restart observer; no new authority
or transport abstraction was needed. Full release verification and publication
remain with the parent firmware-owned successor task. No hardware was used.

Parent verification | 2026-09-14: Full TypeScript, all 605 WebCrypto/browser-unit tests (1704 assertions), browser build, trusted surface, lookup vectors, package dry run and standards pass. Ordered Cargo format, Clippy and build pass. Rust tests stopped in `accepted_work_progress` after two container-creation timeouts; later Rust suites did not run. Docker's engine/API and Desktop status are unresponsive, and its normal restart command timed out. The headless fixture also requires PostgreSQL through Docker; its owned process group was stopped and reaped after identifying that dependency. No checks were disabled or converted into passing evidence. Publication remains blocked until the required checks pass.

Verification resumption | 2026-09-15: Authorized forced Docker Desktop restart succeeded and the engine API responds. TypeScript and all605 WebCrypto tests pass again. Cargo format/Clippy pass; native build fails with cc exit69 because the selected Xcode/Apple SDK license is unaccepted. The Rust test stage and headless verification cannot complete until the owner reviews and accepts the agreement. No license acceptance or toolchain bypass was performed; publication remains blocked.

Completion review | 2026-09-15: The owner accepted the Xcode agreement and the selected SDK is available again. Ordered Cargo format/Clippy/build/tests pass (352 tests, two existing ignored), as do 605 WebCrypto tests, TypeScript, browser build, headless verification, trusted-surface, lookup-vector, package and standards checks. The closed statistics grammar and restart readiness behavior are software-verified. Firmware hardware qualification remains separate and unverified; this task grants no device effect authority.
