# Fresh Hello resynchronization

Type: task
Status: claimed
Blocked by: None

## Objective

Firmware task `task-fixed-usb-hello-resynchronization` records complete stale
device replies left before fresh Hello after abrupt loss. Reproduce this through
the production browser channel, then admit only a fresh nonce-bound Hello within
bounded bootstrap input. Preserve strict framing/integrity, exact identity,
possession, receive counters, deadlines and stream/lock cleanup.

## Plan

- [x] Reproduce a complete stale control reply before fresh Hello.
- [x] Implement bounded bootstrap handling and adversarial regressions.
- [x] Run full Gate verification and review the exact consumer source.
- [ ] Bind firmware-owned no-mining hardware evidence; no mining authority here.

## Comments

2026-09-10: Scope is browser fresh-session recovery. Firmware owns the device
contract and four-cycle evidence. Historical acceptance results remain unchanged.

The original production-channel test failed with `admission_failed` before the
fix. The Hello exchange had accepted old receive credits only; a complete old
Controller reply was misinterpreted as the new acknowledgement. Bootstrap now
validates and discards bounded old device records, with original lexical byte
accounting and synchronous admission at the fresh acknowledgement delimiter.
One 2800-ms Hello deadline includes native send and backlog processing. No
discarded record updates authority, receive counters, peer history or diagnostics.

The 39 focused tests pass, including mixed fragmentation/coalescing, stale Ack
followed by partial output, 32/33 records, 66560/66561 lexical bytes, invalid
reply IDs/shapes, stale-only timeout, and strict post-admission parsing/cleanup.
Review corrected canonical request-ID validation and cleared recovery counters
before reconnect. Full Gate verification passed: 352 Rust tests (two existing
opt-in tests ignored), 434 web/crypto tests, browser conformance, formatting,
lint, type checking, browser/native builds, package/lookup and standards checks.
Software is ready for publication; exact-pair hardware evidence remains pending
in the firmware task. No additional hardware or mining evidence is claimed.

Pre-hardware follow-up: interrupted possession can leave a response using the
possession profile and `pos_` request IDs. The published conformance response
reproduced `admission_failed` against the first fix. Reuse the existing possession
response/claims parser to validate and discard that old response; never use it
to establish a fresh possession. New regressions require an actual fresh proof,
reject malformed old IDs/claims, and accept a well-formed old proof rejection.

Supplemental verification passed: 43 focused reconnect tests, 352 Rust tests
(two existing opt-in ignores), 438 web/crypto tests and full browser, type,
build, package, lookup, formatting/lint and standards gates. Independent review
found no remaining blocker. Hardware remains owned by the firmware task.

First no-mining hardware admission passed on firmware `1b888f44` / Gate `ad961ea`.
Its new checker required restoration confirmation although the idle cold
baseline permits `not_required`. The firmware task preserved the attempt and
all original artifacts without claiming cycles or mining. A distinct
`deviceBaselineConfirmed` observation now captures the actual supported baseline
status; the existing restoration flag remains strict. Sixteen focused predicate
tests cover accepted, missing, invalid and nonbaseline observations.

`helloRecovery.discardedReplies` additionally counts validated old Controller or
possession responses. Hardware evidence must distinguish this repaired path
from already-supported old credits. The combined 59 focused browser tests and
27 no-mining supervisor tests pass. One default
native test launch stalled at `_dyld_start` before any Rust test frame; its
trace is retained. Full verification passed with debug information disabled:
352 Rust tests (two existing opt-in ignores), 454 web/crypto tests, browser
conformance, format/lint/type/build/package/lookup and standards checks. No test
or safety deadline was widened. The firmware task owns fresh attempt 002.
