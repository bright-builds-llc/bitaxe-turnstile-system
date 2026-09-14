# Controlled qualification restart and expected-reset observation

Type: task
Status: resolved
Blocked by: None

## Objective

Implement the firmware owner's prospective Stage B software interface in this
isolated worktree. No restart, hardware access, signing, publication or change to
the retained observation pair is authorized by this source task alone.

## Plan

- [x] Add strict nonce/boot-bound restart request and acknowledgement types.
- [x] Prearm a bounded observer and switch framing synchronously at the matched ACK.
- [x] Preserve the granted port/WebLock; allow one explicitly recorded same-port reopen.
- [x] Reacquire fresh Hello, exact identity, possession and baseline without discovery.
- [x] Expose only an explicitly configured qualification page path and closed evidence.
- [x] Test coalescing, bounds, interruption, identity, replay and cleanup.
- [x] Complete canonical verification and publication after parent coordination.

## Constraints

One consumed request, 30 seconds, at most 512 received records and 262144 bytes.
No heartbeat/lease extension, mining grant, HTTP/DTR/ROM reset or automatic retry.
Raw bytes and the correlation nonce never enter public diagnostics or page state.
A reopened stream is explicitly discontinuous. Existing write/admission bounds
and late native cleanup ownership remain enforced.

## Implementation checkpoint

The isolated SDK/page path is implemented. A matching current-session ACK
changes the existing framer synchronously; the old terminal write then settles
before logical counters are reset. The same physical reader/port remains owned
when uninterrupted. One explicit same-object reopen retains WebLock ownership,
rechecks cancellation before native open and requires boot/startup observations
again after the gap. A second interruption, missing boot, malformed ACK, wrong
identity, timeout or cleanup failure stays unverified; no reset is retried.

The nonce digest covers UTF-8 canonical nonce text. Protected evidence retains
only closed parsed diagnostics with record/time indexes and lifecycle markers;
no raw nonce, serial bytes or possession/session proof is exported. Completed
and failed snapshots freeze, and the whole-read byte budget prevents a
coalesced tail from escaping accounting. Fresh admission and the existing
bounded same-origin helper were extracted to keep the controller/page within
the repository's file-size limit without introducing another transport owner.

Verification: 22 focused restart/observer/owner/page tests passed, followed by
the full Node suite (590 tests, 1649 assertions, zero failures in 39.74 seconds).
TypeScript, Bright Builds all and diff whitespace checks passed. Tests cover
actual-channel ACK/boot coalescing, no-selection uninterrupted recovery,
same-port reopen, second-interruption rejection, post-gap re-observation,
shared record/byte/time bounds, expired prearm, cancellation during native close,
active-work/ordinary-adapter rejection, nonce privacy and frozen evidence.
An actual-page regression proves that close, reconfiguration to a new firmware
pair and reconnect preserve the original private baseline; changed settings
remain a mismatch. Native read errors are distinguished from decoder callbacks
so an application exception cannot authorize a port reopen.

The simplification review retained one observer and the existing port owner,
with shared admission logic rather than a second handshake implementation. The
restart path adds no discovery, network control or authority extension.
Full canonical verification and publication remain pending parent coordination.
No hardware action, commit or push has been performed from this worktree.

## Answer

The qualification-only restart interface is source-complete. Final review added
a regression and fix ensuring queued old-boot healthy snapshots cannot count
toward new-boot readiness. All observations remain preserved; two advancing
healthy samples after the expected new boot are required.

Final verification passes: ordered Cargo format/Clippy/build/tests (352 passed,
two existing ignored), TypeScript, 24 focused tests, the full Bun suite
(592 passed, 1663 assertions), rebuilt browser artifacts, headless browser
verification, lookup vectors, package dry-run, Bright Builds and diff checks.
No device restart or hardware acceptance is claimed by this ticket. The firmware
owner's prospective exact-pair contract owns installation, controlled restart,
accounting and physical cleanup evidence.
