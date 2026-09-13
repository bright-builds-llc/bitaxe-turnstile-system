# Cadence admission during normal heartbeat writes

Type: task
Status: resolved
Blocked by: None

## Objective

Reproduce and fix the local cadence admission rejection observed after a healthy
idle capture and again after fresh possession. Distinguish normal serialized
heartbeat transmission from cancelled or interrupted control records; preserve
all existing record deadlines, authentication, fresh-session and mining guards.
The firmware owner reported that no mining allowance was issued in this failure.

## Plan

- [x] Reproduce the actual controller's rejection with a normally completing heartbeat write.
- [x] Route cadence proof/review through the existing bounded serialized writer.
- [x] Retain rejection of active/pending controls and cancelled/failed records.
- [x] Run required verification and publish an exact clean Gate build for the owner.

## Findings

The failed hardware preparation used Gate source
`687021821affa33ca0afbdd5bf21f93e4adfc83b`. Its `unfinishedRecord` check treated a
normal, in-progress heartbeat write as an invalid idle state. That channel flag
covers every frame between serialization and receive-credit/native-write
settlement; it does not identify only cancelled or partial control records.
The cadence helper checked it both before and after refreshing possession, so
normal heartbeat timing could reject either guard. The sixty-second possession
window was not the cause: review already obtains a fresh proof.

Actual-controller tests reproduced both guards using a real encoded/credited
heartbeat with delayed native settlement. Before the correction, both review
calls rejected immediately. The fix removes only that generic write-busy test;
normal proof/review requests queue behind heartbeat completion using the existing
two-second record deadline. Active leases and pending control requests remain
rejected. A stuck heartbeat retains its timeout as the first diagnostic cause
(the public possession API maps the failed proof to `possession_failed`). A
cancelled partial control remains unusable until explicit fresh Hello/possession.

The initial regression batch passed 52 focused tests after correcting a test-only
expectation of the public failure wrapper. TypeScript also required explicit
qualification-hook typing in the new fixture. These fixture corrections changed
no production deadline, error projection or authentication rule. The original
failed hardware preparation remains unverified and its evidence is unchanged.
This correction is software-only; another physical preparation requires the
firmware owner's prospective supersession and admission checks.

## Answer

The narrow idle guard correction is software-verified. Ordered format, Clippy,
all-target build and Rust tests passed (352 tests; two existing opt-in tests
ignored). All 549 web/crypto tests and 1511 expectations passed, followed by
browser conformance, lookup vectors, package verification and standards.
The new regression covers both healthy-heartbeat races, the unchanged timeout,
cancelled partial-record rejection/fresh-session recovery, and possession refresh
after sixty-one seconds idle. No final verification process stalled or failed.
Logs remain under `artifacts/cadence-heartbeat-admission-20260913/`.

Hardware cadence, USB qualification and migration remain unverified. This
software correction does not supersede, retry or promote the failed preparation;
a new firmware-owned pre-mining preparation contract must preserve that result
and establish the next admissible boundary before additional hardware effects.
