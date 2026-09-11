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

2026-09-10: Firmware-owned attempt 002 completed four current-pair no-mining
cycles and recovered from the exercised foreground and admission interruptions.
The retained bootstrap observations contained only non-control records; they
did not prove recovery across a complete stale Controller or possession reply.
The earlier timing-based interruption remains an unverified result for that
specific criterion. Its original evidence and non-claims remain unchanged.

The qualification-only `interruptPendingStatusForQualification()` API now
selects an observed transport boundary. It requires the explicit qualification
hook, fresh parsed baseline/no lease, one exclusive read operation and unchanged
connection generation. After that baseline read, it sends one ordinary status
request and waits for the production channel's complete send, including the
device's final receive credit. Only a still-pending correlated response permits
revocation and stream/port/lock cleanup without further wire writes. A response
already delivered returns an explicit no-interruption receipt and leaves the
connection open. No Start, grant, signing, budget, synthetic response, firmware
delay, or automatic reconnect is introduced.

The closed `worker-read-interruption-v1` receipt contains only `interrupted`,
`request_consumed`, `response_pending` and `ownership_released` booleans. It
establishes the host-side interruption and cleanup boundary, not the existence
of a complete stale device reply. A later fresh admission must independently
observe positive `helloRecovery.discardedReplies` to establish that criterion.
Firmware continues to own source publication, the successor hardware contract,
four-cycle evidence, accounting continuity and final cleanup review.

Test-first verification reproduced the missing API before implementation. The
71 passing focused tests (196 expectations) cover the new actual-credit and
delayed-response boundary plus production Controller, bootstrap, Hello-order
and flow-control regressions. They also cover absent qualification hook, active
lease, concurrent operations, missing credit, generation closure, no later
writes and already-delivered no-interruption. Type checking and diff checking
passed. The extracted exchange helper keeps the Controller runtime at 628 lines
while retaining ordinary request timeout/failure behavior. Full ordered Gate
verification for this successor revision is pending below; no new hardware
success or parity promotion is claimed by this software work.

2026-09-10: Successor publication is blocked by incomplete full verification.
The first ordered no-debug-profile run passed formatting, Clippy, type checking
and native/browser builds, then the existing Rust lifecycle SSE expiry test
returned `Elapsed(())`. The unchanged exact test subsequently passed (1 test),
and its unchanged complete lifecycle suite passed (21 tests). No Rust source,
assertion or deadline was changed, and no specific cause for that timeout is
claimed.

The second full run again passed the build-stage checks but stopped making
progress while launching `governance_cli`, before any test frame. A bounded
sample contained only `_dyld_start`. The firmware task's independent trivial
native executable also compiled successfully but produced no output before its
bounded launch check expired. These observations establish a verification
execution blocker in this agent session; they do not establish a machine-wide
operating-system cause or justify security/toolchain/cache changes.

Only the owned stalled Gate test child received SIGTERM. Its verifier exited
with status 101, and a subsequent process inventory confirmed all eight owned
verifier/test processes absent. Failed, focused, suite and retry logs, the
bounded sample and explicit cleanup receipt remain in the ignored local
`artifacts/read-interruption-verification.oBIamf/` directory. The 71 focused
browser tests and type check remain valid software evidence, but the mandatory
full gates are incomplete. Source and documentation remain uncommitted and
unpushed; no new hardware attempt is authorized by this record. Resume complete
verification after the execution boundary is independently shown to work,
then publish and rebuild the browser bundle from its exact committed HEAD.

2026-09-10: Verification resumed after the independent native launch control
returned success. The ordered `cargo fmt --all` and `bun run verify` completed
with `CARGO_PROFILE_DEV_DEBUG=0` and `CARGO_PROFILE_TEST_DEBUG=0`: 352 Rust tests
passed with two existing opt-in ignores; all 462 web/crypto tests passed.
Browser conformance, Clippy, type checking, native/browser builds, package and
lookup checks, and standards checks also passed. The resumed full log is retained
locally in `artifacts/read-interruption-publication.IP103C/full-verify.log`.
Earlier timeout, stalled-launch and cleanup records remain unchanged; no Rust
source, test assertion or deadline was changed to obtain this result.

The user requested source commit/push after these gates. This software revision
is ready for publication and a browser rebuild stamped with its committed HEAD.
Hardware remains governed by the firmware-owned successor contract; no new
device execution, complete stale-reply recovery or parity promotion is claimed.
