# BWG Worker USB Separation Implementation Map

## Parent

This child effort resolves the USB transport prerequisite for
[`bwg-core` Ticket 23](../bwg-core/issues/23-real-bitaxe-restoration-evidence.md) without
renumbering the BWG Core roadmap. Ticket 21 remains the resolved Controller 0.1 semantic,
simulator, and Web Serial contract; this effort owns the application-time separated transport and
real Reference Firmware evolution.

## Decisions so far

- [ADR 0091](../../docs/adr/0091-separate-local-worker-control-from-runtime-evidence.md) separates
  bidirectional local Worker control from receive-only runtime evidence.
- The higher-level `WorkerController` interface remains stable. Controller 0.2 and Worker USB 0.1
  remain unchanged compatibility profiles; possession-bound production control advances to
  Controller 0.3 and Worker USB 0.2.
- `bwg-worker-usb/0.2` retains the exact application TinyUSB descriptor while its vendor-specific
  WebUSB function carries only possession and Controller frames; CDC evidence remains distinct and
  receive-only.
- ROM USB Serial/JTAG is bootloader/debug-only. Bootloader/application changes require explicit
  Transport Reacquisition and never preserve an active Work Lease.
- Device Identity possession and enumeration identity remain separate. USB serial, VID/PID, and
  enumeration values are admission hints only; ambiguity, drift, unexpected ownership, or
  continuity loss fails closed before further control.
- The gate repository owns profiles, fixtures, browser adapters, and composed conformance;
  `bitaxe-esp-miner` owns the Reference Firmware adapter and hardware evidence.
- [Ticket 01](./issues/01-separated-usb-contract.md) published the glossary, ADR, ownership split,
  versioning decision, threat model, initial dependency graph, and parent prerequisite without
  production code or hardware effects.
- Ticket 02's throwaway prototype confirmed the separated topology and found one required state:
  identity drift enters `restoration_pending`, and only reacquisition of the original physical
  Worker plus restoration proof can permit public completion.
- [Ticket 02](./issues/02-controller-02-transport-profile.md) published strict Controller 0.2 and
  `bwg-worker-usb/0.1` runtime types, exact TinyUSB descriptor roles, a pure reacquisition reducer,
  executable positive/negative fixtures and schemas, additive package exports, and protocol docs
  while preserving every Controller 0.1 consumer.
- [ADR 0092](../../docs/adr/0092-prove-local-worker-continuity-with-device-identity.md) requires
  additive Controller 0.3, Worker USB 0.2, and fresh-nonce Device Identity possession profiles
  before local Worker control can start or resume.
- Ticket 03 owns that possession profile. Ticket 04 consumes it in the browser, Ticket 05 consumes
  it in Reference Firmware, and Ticket 06 composes their hardware evidence.
- [Ticket 03](./issues/03-local-device-possession-proof.md) published Controller 0.3, Worker USB
  0.2, and the one-shot Local Device Possession Proof with strict schemas, executable fixtures,
  WebCrypto verification, and additive package exports while preserving every earlier profile.
- [Ticket 04](./issues/04-reference-client-webusb-adapter.md) added the production possession-bound
  WebUSB adapter, challenge-scoped durable fingerprint retention, restoration-gated recovery and
  cleanup, and real Chromium permission/reacquisition/privacy conformance.

## Delivery order

1. [x] [Publish the separated USB contract and threat model](./issues/01-separated-usb-contract.md)
1. [x] [Prototype and publish Controller 0.2 transport fixtures](./issues/02-controller-02-transport-profile.md)
1. [x] [Publish possession-bound Controller 0.3 transport profiles](./issues/03-local-device-possession-proof.md)
1. [x] [Add the production Reference Client WebUSB adapter](./issues/04-reference-client-webusb-adapter.md)
1. [ ] [Implement the Reference Firmware composite USB adapter](./issues/05-reference-firmware-composite-usb.md)
1. [ ] [Prove cross-repository restoration and close the parent](./issues/06-real-hardware-restoration-closure.md)
