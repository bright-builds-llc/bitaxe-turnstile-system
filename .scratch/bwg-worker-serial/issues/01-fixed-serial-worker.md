# 01: Replace prototype Worker USB with fixed Serial/JTAG

**Status:** claimed
**Blocked by:** None

- [x] Record the accepted migration, safety boundaries, and canonical wire contract before implementation.
- [ ] Implement Controller 0.4, serial 0.1, possession 0.2, signed capability 0.2, deployment trust 0.2, and Work Lease authorization 0.2.
- [ ] Integrate direct foreground Web Serial with the actual headless client and bound peer heartbeat independently of command latency.
- [ ] Remove obsolete active WebUSB/controller profiles, exports, fixtures, tests, and build wiring; preserve historical ADR/evidence records.
- [ ] Publish deterministic cross-repository signing/transport fixtures and production-adapter browser conformance.
- [ ] Run formatting, lint, typecheck, build, Rust/web/browser tests, standards checks, and review the diff.
- [ ] Commit and push Gate changes; provide the exact consumer pin to firmware.

## Superseded work

This replaces the active transport implementation of `.scratch/bwg-worker-usb-separation` tickets 01–07. Resolved historical results remain history. Uncompleted tickets 06/07 are superseded for implementation by this task and firmware's native tracker. Core ticket 23 still requires joint real-hardware evidence against the new profile.

## Completion review

Pending. No hardware effects have been performed by this Gate task.
