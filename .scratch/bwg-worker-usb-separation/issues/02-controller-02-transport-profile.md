# 02: Prototype and publish Controller 0.2 transport fixtures

**What to build:** Validate the application USB topology at a disposable descriptor/host seam,
then publish strict Controller 0.2 and `bwg-worker-usb/0.1` profiles with executable fixtures.

**Blocked by:** 01: Publish the separated USB contract and threat model.

**Status:** ready-for-agent

- [ ] A throwaway prototype compares exact WebUSB interface admission and application
  re-enumeration against the accepted TinyUSB composite decision; only findings and durable
  decisions remain.
- [ ] Controller 0.2 preserves Work Lease semantics while strict capability discovery binds the
  new control/evidence transport profile and rejects 0.1 shape drift.
- [ ] Transport fixtures cover descriptor roles, bulk framing, correlation, size limits,
  bootloader/application enumeration, physical identity, and reacquisition.
- [ ] Negative fixtures cover wrong/ambiguous functions, bootloader selection, injected logs,
  unknown fields, malformed transfers, response loss, disconnect, and identity drift.
- [ ] Versioned package exports let firmware CI consume schema and fixtures without a Git submodule
  or implementation-internal import.
- [ ] Existing Controller 0.1 fixtures and package exports remain valid for existing consumers.

## Answer

Pending.
