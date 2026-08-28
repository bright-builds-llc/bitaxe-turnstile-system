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
- The higher-level `WorkerController` interface remains stable while the strict wire profile
  advances to `bwg-worker-controller/0.2`.
- `bwg-worker-usb/0.1` owns the application TinyUSB topology: vendor-specific WebUSB control plus
  distinct receive-only CDC evidence.
- ROM USB Serial/JTAG is bootloader/debug-only. Bootloader/application changes require explicit
  Transport Reacquisition and never preserve an active Work Lease.
- Physical USB identity and enumeration identity remain separate. Ambiguity, drift, unexpected
  ownership, or continuity loss fails closed before further control.
- The gate repository owns profiles, fixtures, browser adapters, and composed conformance;
  `bitaxe-esp-miner` owns the Reference Firmware adapter and hardware evidence.
- [Ticket 01](./issues/01-separated-usb-contract.md) published the glossary, ADR, ownership split,
  versioning decision, threat model, five-ticket dependency graph, and parent prerequisite without
  production code or hardware effects.

## Delivery order

1. [x] [Publish the separated USB contract and threat model](./issues/01-separated-usb-contract.md)
1. [ ] [Prototype and publish Controller 0.2 transport fixtures](./issues/02-controller-02-transport-profile.md)
1. [ ] [Add the production Reference Client WebUSB adapter](./issues/03-reference-client-webusb-adapter.md)
1. [ ] [Implement the Reference Firmware composite USB adapter](./issues/04-reference-firmware-composite-usb.md)
1. [ ] [Prove cross-repository restoration and close the parent](./issues/05-real-hardware-restoration-closure.md)
