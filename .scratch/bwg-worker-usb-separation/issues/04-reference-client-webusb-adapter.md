# 04: Add the production Reference Client WebUSB adapter

**What to build:** Implement the browser production adapter behind the stable `WorkerController`
interface, hiding permission, WebUSB transfer, interface admission, reacquisition, and disconnect.

**Blocked by:** 03: Publish possession-bound Controller 0.3 transport profiles.

**Status:** ready-for-agent

- [ ] A direct user gesture is the only path to request one local USB device and claim the exact
  vendor-specific Controller 0.3 control function.
- [ ] The adapter admits exact signed Reference Firmware capability and physical continuity before
  sending any Work Lease request; ambiguity or wrong function fails without a write.
- [ ] Bootloader/application and reboot enumeration changes use bounded Transport Reacquisition
  rather than stale `USBDevice` or interface state.
- [ ] Bulk request/response correlation, bounds, timeouts, cancellation, response loss, and
  disconnect remain behind the existing high-level `WorkerController` interface.
- [ ] Disconnect and cleanup compose device-local Mining Baseline restoration before public client
  lifecycle completion.
- [ ] Real Chromium tests prove explicit permission, wrong-device/function negatives,
  re-enumeration, terminal restoration ordering, accessibility, and byte-level privacy.

## Answer

Pending.

## Comments

An implementation review proved the permission, exact-function, bounded-transfer, restoration,
cleanup, privacy, and Chromium seams, then found that a serial-derived digest cannot establish
same-Worker possession. Ticket 04 must consume Ticket 03 before any production export or claim.
