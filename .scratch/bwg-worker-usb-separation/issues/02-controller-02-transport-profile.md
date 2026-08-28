# 02: Prototype and publish Controller 0.2 transport fixtures

**What to build:** Validate the application USB topology at a disposable descriptor/host seam,
then publish strict Controller 0.2 and `bwg-worker-usb/0.1` profiles with executable fixtures.

**Blocked by:** 01: Publish the separated USB contract and threat model.

**Status:** resolved

- [x] A throwaway prototype compares exact WebUSB interface admission and application
  re-enumeration against the accepted TinyUSB composite decision; only findings and durable
  decisions remain.
- [x] Controller 0.2 preserves Work Lease semantics while strict capability discovery binds the
  new control/evidence transport profile and rejects 0.1 shape drift.
- [x] Transport fixtures cover descriptor roles, bulk framing, correlation, size limits,
  bootloader/application enumeration, physical identity, and reacquisition.
- [x] Negative fixtures cover wrong/ambiguous functions, bootloader selection, injected logs,
  unknown fields, malformed transfers, response loss, disconnect, and identity drift.
- [x] Versioned package exports let firmware CI consume schema and fixtures without a Git submodule
  or implementation-internal import.
- [x] Existing Controller 0.1 fixtures and package exports remain valid for existing consumers.

## Answer

The throwaway prototype on local branch `codex/prototype-worker-usb-topology` confirmed that ROM
USB Serial/JTAG, application WebUSB control, and CDC evidence remain non-interchangeable. It exposed
one necessary correction now present in the durable model: identity drift, control loss, or an
unknown response outcome enters `restoration_pending`; only the original physical Worker under a
new enumeration identity can confirm restoration and unblock public completion.

Controller 0.2 reuses the exact Controller 0.1 capability-label, lease-window, endpoint,
credential-bound, status, and restoration parsers rather than duplicating semantics. Its strict
capability changes only the wire version, `web_usb` transport, and bound
`bwg-worker-usb/0.1` profile, then requires an Ed25519 Update Authority JWS over the exact public
capability and application descriptor digest. A generic `WorkerControllerContract` preserves one deep method surface
while existing `WorkerController` remains the unchanged 0.1 specialization and
`WorkerControllerV02` supplies strict 0.2 types.

`bwg-worker-usb/0.1` fixes one TinyUSB configuration: vendor-specific WebUSB control interface 0
uses exact class/subclass/protocol and bulk endpoints, while CDC evidence owns separate
communication/data interfaces and rejects host writes. The pure session reducer distinguishes
physical from enumeration identity, enforces changed-enumeration reacquisition, keeps JSON-shaped
evidence observational, and makes uncertain control outcomes restoration-pending.

Strict Draft 2020-12 schemas and executable fixtures cover signed 0.2 capability,
grant/renewal/status, every command, typed failures, correlation, empty/oversized/invalid/truncated
transfers, descriptor roles, bootloader/application reacquisition, identity drift, control and
response loss, wrong or ambiguous functions, bootloader control attempts, descriptor drift,
unknown fields, multiple frames, and log injection. Browser ESM/declarations, both fixture
sets, schemas, and protocol documents ship through explicit package subpaths; package dry-run
proves every surface is included while all Controller 0.1 tests and exports remain green.

## Prototype

The throwaway logic prototype is captured off main at branch
`codex/prototype-worker-usb-topology`, commit `95aea87`. It asked whether bootloader USB
Serial/JTAG, application WebUSB control, and CDC evidence could remain non-interchangeable while
restoration preceded public completion.

The accepted topology remained coherent, but identity drift exposed a required intermediate state:
the host cannot claim the Mining Baseline immediately after losing the original Worker.
`restoration_pending` must block public completion until the original physical Worker is reacquired
under a new enumeration identity and returns restoration confirmation. The production profile and
fixtures encode that state explicitly.
