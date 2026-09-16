# Fixed-serial Noise diagnostic readiness

Type: task
Status: claimed
Blocked by: Firmware bounded crypto cancellation and combined-owner readiness

## Objective

Implement Gate's portion of firmware task
`task-str005-noise-runtime-readiness` against frozen contract
`str005-noise-serial-v1` (SHA-256
`0da417fc198a89042eb62902999ac822be5365a5f0333df8220f15afe3447a62`).
No hardware, mining, lease signing or historical acceptance changes.

## Plan

- [x] Add closed typed Start and status parsing with bounded metadata.
- [x] Add the three Controller methods with exact-pair opt-in and possession checks.
- [x] Preserve consumed admission after ambiguity and exclude competing effects.
- [x] Verify production serial dispatch, correlation and privacy with fixtures.
- [ ] Complete same-page before/candidate/recovery browser integration.
- [ ] Join the actual firmware implementation and independent host fixture.
- [ ] Complete coordinated publication and required verification.

## Progress | 2026-09-16

The parser and client slice is software-only. Ordinary controllers cannot use
these commands; qualification must explicitly bind the same source and ELF pins
as the admitted controller. No existing signed capability claims were widened.
No acceptance-page route enables the opt-in yet. The page lifecycle and actual
firmware integration remain unfinished, so this record is not runtime readiness.

The pinned firmware crypto path has no supported cooperative cancellation seam
inside synchronous ElligatorSwift preparation. Independent revocation does not
establish the frozen five-second quiescence bound. The firmware owner retains
that blocker and the unmodified contract. Gate must not route around it or claim
that this parser/client implementation permits hardware.

Initial verification: TypeScript passes and 59 targeted parser/control tests
pass, including production credited serial dispatch, private metadata exclusion,
wrong pair/binding rejection and ambiguous Start without resend. Full coordinated
verification is pending. The private baseline remains owned by the existing page;
this slice adds no export/import or recovery shortcut.

Verification review | 2026-09-16: Ordered Cargo format, Clippy, all-target build
and tests pass (352 passed, two existing ignored). TypeScript, all 687 WebCrypto
and browser-unit tests (1829 assertions), browser build, headless conformance,
trusted surface, lookup vectors, package dry run and Bright Builds checks pass.
The focused Noise subset has 82 passing tests and 125 assertions. Review added
immutable identity/stage/failure/terminal retention, valid late cleanup without
clearing an incomplete-job fence, missing-address and stale-observation rejection,
and early exclusion of competing qualification helpers including the direct
exchange rejection fixture. Transport timeouts remain typed rejected/expired
pending independent measured deadline judgment; parsing supplies no hardware
acceptance. No acceptance page integration, supported firmware runtime or live
result is claimed. Publication of this bounded slice does not complete the task.

## V2 implementation | 2026-09-16

The reviewed firmware amendment `str005-noise-serial-v2` removes the universal
five-second in-call cleanup guarantee. Readiness resumes under its fixed
admission-plus-125-second failed-job horizon and unchanged 120-second positive
authority envelope. V1 readers retain their original semantics; the current
Controller methods select v2 replies explicitly and retain query-v1 payloads.

- [x] Separate v1/v2 parsing and amended cleanup/fence interpretation.
- [x] Freeze before/candidate exact identity configurations on one loaded page.
- [x] Preserve the original private baseline through normal close/reconnect.
- [x] Add private possession/Start/status/cancel helpers without mining routes.
- [ ] Join production firmware and host fixture/evaluator composition.
- [ ] Complete coordinated verification and publication before hardware.

The optional dedicated recovery route remains unavailable. A fresh page cannot
begin as a candidate or import a preservation baseline; the first before-mode
observation is retained through the admitted update cycles. Noise job metadata
and session bindings never enter the existing public page-state schema. Failed
or ambiguous Start remains consumed across same-page controller replacement.

V2 verification checkpoint | 2026-09-16: Ordered Cargo format, Clippy, build and
tests pass (352 passed, two existing ignored). TypeScript, 707 WebCrypto/browser
unit tests, browser build, package dry run, trusted surface, lookup vectors and
Bright Builds checks pass. The focused version/config/page set has 111 passing
tests. Chromium conformance also passes the production page-operation and serial
controller composition through fresh-session normal restoration, retained
same-page preservation, one consumed Start and released streams/lock. These use
a software device and establish no physical Noise, resource or mining result.
The native producer and independent host/evaluator join remain prerequisites to
closing this readiness task and publishing the admitted pair.

Pending-cleanup integration review | 2026-09-16: The existing closed
`restoration_pending` command rejection now preserves the current possession,
serial owner and resource fence only while the candidate Noise fence is active.
The ordinary Controller parser still rejects baseline/pending combinations, and
ordinary rejection behavior is unchanged. Pending cleanup propagates as an
error; the page never labels it confirmed. Production-controller tests cover
pending Restore, continuing Noise status/cancel, actual cleanup observation and
subsequent confirmed Restore. Early Start/probe guards avoid closing the Noise
session merely because a competing local command was refused. All 710 browser
unit tests and TypeScript checks pass after this correction; browser build and
package checks pass. The prior ordered Rust checks remain applicable: no Rust
source changed. The actual nine-case Rust serialization corpus also passed both
Gate parsing and incomplete-to-late-release progression without changing its
terminal verdict or missed-horizon evidence.
