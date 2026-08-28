# 04: Add the production Reference Client WebUSB adapter

**What to build:** Implement the browser production adapter behind the stable `WorkerController`
interface, hiding permission, WebUSB transfer, interface admission, reacquisition, and disconnect.

**Blocked by:** 03: Publish possession-bound Controller 0.3 transport profiles.

**Status:** resolved

- [x] A direct user gesture is the only path to request one local USB device and claim the exact
  vendor-specific Controller 0.3 control function.
- [x] The adapter admits exact signed Reference Firmware capability and physical continuity before
  sending any Work Lease request; ambiguity or wrong function fails without a write.
- [x] Bootloader/application and reboot enumeration changes use bounded Transport Reacquisition
  rather than stale `USBDevice` or interface state.
- [x] Bulk request/response correlation, bounds, timeouts, cancellation, response loss, and
  disconnect remain behind the existing high-level `WorkerController` interface.
- [x] Disconnect and cleanup compose device-local Mining Baseline restoration before public client
  lifecycle completion.
- [x] Real Chromium tests prove explicit permission, wrong-device/function negatives,
  re-enumeration, terminal restoration ordering, accessibility, and byte-level privacy.

## Answer

`createWebUsbWorkerControllerV03` is the production browser adapter behind the unchanged high-level
Controller interface. It requests one deployment-filtered device only from live browser user
activation, admits the exact USB 0.2 descriptor, verifies the signed Controller 0.3 capability, and
completes a fresh Local Device Possession Proof before any Work Lease command. VID/PID and
enumeration objects remain admission hints; a USB serial is neither required nor authoritative.

The adapter serializes bounded bulk request/response transactions, parses results inside the
outcome-unknown failure boundary, normalizes device errors, rejects stale enumeration objects, and
keeps control unavailable through exact restoration validation and disconnect-handler completion.
Explicit cleanup confirms Mining Baseline restoration before strict interface release and close;
cleanup failure remains retryable instead of being swallowed.

Only `{challengeBindingSha256, deviceIdentityFingerprint, retentionExpiryUnixSeconds}` is retained
in the separate private `bwg-worker` IndexedDB store. Initial admission creates that record;
tab-local recovery re-proves the same key and confirmed baseline, expiry deletes it, and confirmed
terminal cancellation/satisfaction/expiry clears it. Challenge IDs, JWKs, USB serials, proofs,
capabilities, credentials, and response bytes are not persisted or exposed by the connection
result. The fingerprint-bearing storage seam is internal and unavailable through package exports;
trusted same-origin client code is the storage boundary, while same-origin script compromise is an
explicit browser security non-claim.

Unit tests cover gesture ordering, exact descriptors, signed capability and possession admission,
cloneable-serial independence, different-key rejection, durable recovery, expiry and terminal
deletion, atomic first-Worker admission, live retention-scope mismatch, stale enumeration before
control writes, wrong restoration, response loss, malformed successful results, listener
ordering/failure, cleanup retry, and byte-level privacy. Real Chromium drives the built adapter
through named accessible buttons for happy, wrong-device, wrong-function, live reacquisition,
durable recovery, and competing-admission scenarios.

## Comments

The pre-refactor draft was used only as a disposable implementation starting point. Its
serial-derived authority was removed; Ticket 03 possession is now the sole physical-continuity
proof.
