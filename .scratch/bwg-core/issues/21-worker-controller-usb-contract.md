# 21: Publish the Worker Controller and USB contract with a simulator

**What to build:** A versioned cross-repository contract and simulated device let the browser client discover a local Worker, execute bounded Work Leases, and observe safe Mining Baseline restoration without depending on firmware internals.

**Blocked by:** 10: Pause, cancel, expire, and resume safely; 12: Obtain Work Consent through the headless client.

**Status:** resolved

- [x] Capability discovery reports board, firmware, protocol, and preservation compatibility without secrets.
- [x] The contract covers lease start, renewal, status, Pause, Cancel, expiry, lost continuity, reboot, and restoration confirmation.
- [x] Monotonic deadline behavior is observable and independent of accurate device wall time.
- [x] The simulator implements every positive and negative contract scenario.
- [x] The headless client uses the public Worker Controller interface rather than simulator-specific hooks.
- [x] Credentials, Wi-Fi, pool settings, and private keys are absent from public diagnostics.
- [x] The shared fixtures can be consumed by both this repository and the firmware repository.

## Answer

`bwg-worker-controller/0.1` now defines a strict local Worker Controller and bounded USB JSON-lines
contract. Discovery exposes only board, firmware, protocol, lease/restoration, and
settings-preservation compatibility. Start and renewal accept a maximum 60-second lease with a
maximum 20-second renewal hint through a required authorization-verifier port that receives the
complete normalized grant or renewal; public status exposes only opaque challenge/lease IDs,
monotonic deadlines, state, and a closed restoration category.

The deterministic simulator captures an internal Mining Baseline, never exposes it, ignores wall
time for safety, and subscribes directly to clock/continuity changes so expiry, reset, loss, and
reboot restore without polling. Pause, Cancel, USB disconnect, tab closure, and terminal challenge
reasons use the same restoration contract. Invalid protocol shapes, oversized leases, wrong/stale
renewals, failed authentication, secret-bearing public extensions, multi-frame USB input, and
credential-echoing errors fail closed. A transport-agnostic `UsbWorkerController` drives the same
public interface over bounded request/response frames.

The headless client optionally discovers and controls a Worker solely through `WorkerController`.
Authority Start/resume supplies the authenticated grant, renewal composes both seams, device
admission or renewal failure restores the Worker and pauses the Authority while preserving every
rollback error. Pause/Cancel, terminal observations, USB disconnect, and async tab cleanup restore
or pause before client completion. Runtime, simulator, fixtures, and schema have explicit package
subpaths; firmware CI executes the same structured operation/clock/outcome vectors.

The resolved 0.1 profile remains valid for its simulator, Web Serial codec, and headless-client
composition. It does not claim that real Reference Firmware may mix controller frames with runtime
logs. The additive [`bwg-worker-usb-separation`](../../bwg-worker-usb-separation/spec.md) child
effort owns Controller 0.2 application transport separation and the real-firmware prerequisite for
Ticket 23 without reopening this ticket.
