# 01: Publish the separated USB contract and threat model

**What to build:** Publish the accepted control/evidence separation, exact vocabulary, repository
ownership, versioning decision, threat model, and dependency graph without production code or
hardware effects.

**Blocked by:** None. BWG Core Tickets 21 and 22 are resolved.

**Status:** resolved

- [x] Worker Management defines Worker Control Transport, Worker Evidence Transport, and Transport
  Reacquisition without embedding implementation details in the glossary.
- [x] A system ADR records application TinyUSB composition, bootloader/application separation,
  fail-closed reacquisition, and the reason Controller 0.1 cannot be silently reinterpreted.
- [x] The child specification fixes repository ownership, interface stability, Controller 0.2 and
  USB profile versioning, privacy classes, prohibited flows, and real-hardware non-claims.
- [x] BWG Core Ticket 23 depends on this child effort without renumbering or reopening resolved
  Tickets 21 and 22.
- [x] The implementation map exposes an acyclic delivery frontier for browser and firmware work.

## Answer

Worker Management now distinguishes the bidirectional Worker Control Transport, receive-only Worker
Evidence Transport, and fail-closed Transport Reacquisition without embedding USB implementation
details in the glossary. System ADR 0091 records the hard-to-reverse application topology: one
TinyUSB composite device exposes vendor-specific WebUSB control and distinct CDC evidence, while
ROM USB Serial/JTAG remains bootloader/debug-only and never accepts Work Leases.

The child specification fixes Controller 0.2 and `bwg-worker-usb/0.1` versioning, keeps the
higher-level `WorkerController` interface stable, assigns profiles/browser fixtures to this
repository and firmware/hardware evidence to `bitaxe-esp-miner`, and records strict privacy,
reacquisition, threat, and non-claim rules. Five dependency-ordered tickets let browser and
firmware adapters proceed independently after the transport fixtures, then converge on one
cross-repository hardware proof that closes BWG Core Ticket 23. Resolved Tickets 21 and 22 remain
closed and their existing evidence is not reinterpreted.
