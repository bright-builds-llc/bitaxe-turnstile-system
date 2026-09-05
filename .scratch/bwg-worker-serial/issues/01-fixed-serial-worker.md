# 01: Replace prototype Worker USB with fixed Serial/JTAG

**Status:** resolved
**Blocked by:** None

- [x] Record the accepted migration, safety boundaries, and canonical wire contract before implementation.
- [x] Implement Controller 0.4, serial 0.1, possession 0.2, signed capability 0.2, deployment trust 0.2, and Work Lease authorization 0.2.
- [x] Integrate direct foreground Web Serial with the actual headless client and bound peer heartbeat independently of command latency.
- [x] Remove obsolete active WebUSB/controller profiles, exports, fixtures, tests, and build wiring; preserve historical ADR/evidence records.
- [x] Publish deterministic cross-repository signing/transport fixtures and production-adapter browser conformance.
- [x] Run formatting, lint, typecheck, build, Rust/web/browser tests, standards checks, and review the diff.
- [x] Prepare the verified Gate publication and exact consumer pin inputs for firmware.

## Superseded work

This replaces the active transport implementation of `.scratch/bwg-worker-usb-separation` tickets 01–07. Resolved historical results remain history. Uncompleted tickets 06/07 are superseded for implementation by this task and firmware's native tracker. Core ticket 23 still requires joint real-hardware evidence against the new profile.

## Completion review

Controller 0.4 and serial 0.1 are the only active local Worker profile. Possession/capability/deployment trust and lease authorization use their agreed 0.2 contracts. Production Web Serial, foreground loss, bounded independent heartbeat, exact frame probe, headless Start/Renew composition, streaming private signing, delayed post-chooser challenge activation, and the protected acceptance-page API are implemented. Obsolete active WebUSB code, exports, fixtures, and generated outputs are removed; historical ADR and protocol records remain.

Verification passed: `bun run format`, full `bun run verify`, and final affected TypeScript/build/package/browser/standards checks. Final web and CLI suite: 263 passing tests, including production-adapter/headless composition, late chooser activation, long graceful cooling interrupted by foreground loss, private stdin/stdout signing, raw payload size, duplicate keys, LF-only framing, and signed campaign bounds. Diff reviewed. Requirements were committed first as `8392d8a`.

Residual risks: physical USB recovery, three-second device shutdown initiation, telemetry quality, actual accepted mining work, and cooled baseline restoration still require the firmware repository's task-gated exact-package campaign. Gate conformance signers are non-production fixtures; deployment trust is explicitly supplied and may retain existing public authority entries. No hardware effects were performed by this Gate task. The final pushed Gate commit is supplied to the firmware owner as the consumer pin.
