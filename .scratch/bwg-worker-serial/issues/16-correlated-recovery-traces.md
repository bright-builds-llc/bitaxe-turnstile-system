# Correlated recovery observations

Type: task
Status: resolved
Blocked by: None

## Objective

Record bounded metadata at the real browser receive/framing/validation/delivery
boundaries, retain it across close and fresh Hello, and export it explicitly.
Correct future interruption receipts so a pending response promise does not
claim that response bytes remain undelivered. Firmware owns device tracing,
publication and live recovery effects.

## Plan

- [x] Add bounded numeric/category-only browser and device export parsers.
- [x] Reproduce coalesced credit/reply with delayed digest and retain boundary evidence.
- [x] Add one-use, explicitly armed diagnostic work loss without graceful wire writes.
- [x] Verify actual channel regressions and full Gate checks; preserve historical results.

## Comments

2026-09-11: The firmware task authorizes the loss/resume qualification contract.
No hardware runs or accounting authority originate in this software task.

The production-channel regression demonstrates a fully received coalesced reply
whose integrity hash remains pending when its request-consumed promise resumes.
Version 2 receipts describe only that promise and numeric observation boundary.
The browser trace records assembly, validation and suppression after close,
retains epoch-bound observations through fresh Hello, and exports no payloads.

The one-use loss phase journals parsed actual work before cutting ownership;
the runtime discounts journal elapsed time from fresh shutdown headroom. No
control, Restore or courtesy Close record is sent. The fixture intentionally
remains device-active after host release: shutdown is not claimed by that
receipt. Device observations after fresh admission belong to firmware review.

All 483 web/crypto tests pass (1343 expectations). Type checking, scoped Markdown
formatting and standards checks pass. The initial full verifier and a controlled
single-job variant stopped making progress inside Clippy and were canceled with
confirmed owned-process cleanup. Their original records and bounded samples are
retained in `artifacts/correlated-recovery-qzr7Na/`; symbolication itself exceeded
the diagnostic bounds. No existing cache was manually edited or deleted. Native
source, toolchain, security settings and test deadlines stayed unchanged. A new isolated Cargo target is being used
for the final controlled full-verification variant.

A separate focused Bun command used unprefixed positional filters and stalled
in directory enumeration. The unchanged test files passed when invoked with
explicit `./` paths, as required by Bun's documented distinction between file
paths and discovery filters. The canonical package scripts already use those
explicit paths. This finding does not explain the Clippy wait or establish a
machine-wide operating-system failure.

## Answer

The fresh-target full verification passed: formatting, Clippy, TypeScript,
native/browser builds, 352 Rust tests (two existing opt-in ignores), 483
web/crypto tests, browser conformance, package/lookup and standards checks.
The run completed in 481.9 seconds with confirmed cleanup. Fresh output files
allowed this verification to complete; cache corruption or an OS-wide cause
has not been established.

A final follow-up makes the explicit device trace review obtain fresh idle
possession after Stop, which consumes the preceding possession. Running or
loaded-window calls are rejected before any proof request. The actual-channel
Stop-to-export regression and 18 focused tests passed, followed by TypeScript
and the full browser suite. Traces remain separate from repeatedly published
acceptance state. Root supervisor review owns immutable export files, exact
epoch-window correlation, loss/resume accounting and hardware conclusions.

Publication does not promote historical attempts or claim a successful physical
recovery. All original failed/canceled evidence remains retained unchanged.

The firmware review confirmed that accepted signed Start/Renew advance NVS
`lease_seq` and its authorization fingerprint. A separate one-use post-work
checkpoint now preserves that expected value privately instead of resetting the
original baseline. Public checkpoint metadata starts pending, compares only
after a fresh session with the same generation, and keeps missing/rollback
observations false. Explicit resume configuration can clear it only after a
passed loss completion. The actual callback-order regression covers authorized
advancement across reconnect while the original baseline correctly stays false.

The final checkpoint follow-up passed TypeScript and all 497 web/crypto tests
(1377 expectations). Boundary or journal errors also clean up an active
controller before any polling timer exists, preserving the primary error when
cleanup fails. Native Rust source is unchanged from the completed ordered gates;
the final browser build/conformance follow-up passed against the retained fresh
Cargo target. No further authority, allowance, hardware effect or retry is added.

The final state-isolation regression rejects a phase-less downgrade on an
already configured recovery page. Seventeen focused recovery/configuration/
checkpoint tests and TypeScript passed after that guard; legacy first-use
configuration and the explicit sealed loss-to-resume transition remain supported.
