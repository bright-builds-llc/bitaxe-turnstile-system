# BWG Worker USB 0.1

## Scope

`bwg-worker-usb/0.1` defines the local physical transport topology used by Worker Controller 0.2.
It separates bidirectional application control from receive-only runtime evidence and makes every
bootloader/application enumeration change explicit. It does not define Work Lease policy or
controller state transitions beyond the transport restoration gate.

## USB roles

One physical Ultra 205 USB connector exposes different controllers by lifecycle:

- ROM USB Serial/JTAG is `flash_debug_only` and never accepts Worker Controller requests.
- Application Reference Firmware owns one TinyUSB composite device.
- Its vendor-specific `worker_control` function carries only bounded WebUSB controller frames in
  both directions.
- Its CDC ACM `worker_evidence` function carries only redaction-safe device-to-host observations
  and never accepts commands.

The application descriptor is exact: configuration 1 uses vendor-specific control interface 0,
alternate 0, class/subclass/protocol `255/66/1`, and bulk OUT/IN endpoint 1. CDC evidence owns
communication interface 1, data interface 2, notification IN endpoint 2, and data OUT/IN endpoint
3; firmware must not accept host writes on that CDC data path. VID/PID and product identity remain
deployment-bound rather than being fabricated by this profile.

Logs, evidence, and JSON-shaped observations cannot become controller frames. Controller responses
cannot be emitted through CDC evidence. A browser or host must not probe an unadmitted CDC or
bootloader function with a Work Lease request.

## Identity and reacquisition

Physical Worker identity and enumeration identity are distinct redacted digests. Moving from ROM
bootloader USB Serial/JTAG to application TinyUSB requires:

1. the same admitted physical Worker identity;
1. a changed enumeration identity;
1. the exact separated transport profile; and
1. explicit application capability admission before any controller write.

A repeated enumeration identity is not reacquisition. A different physical identity, unexpected
function, missing profile, or invalid capability blocks control.

## Restoration gate

Identity drift or loss of original-Worker contact enters `restoration_pending`. It does not imply a
confirmed Mining Baseline. Public completion remains blocked until the original physical Worker is
reacquired under a new enumeration identity and supplies restoration confirmation. Reboot,
monotonic reset, disconnect, and continuity loss likewise cannot resume an old lease.

## Prototype finding

The throwaway state-model prototype is retained off main at local branch
`codex/prototype-worker-usb-topology`, commit `95aea87`. It confirmed the separated topology and
exposed the required `restoration_pending` state; only that finding and the durable reducer remain
on main.

## Conformance artifacts

- [`fixtures.json`](../../conformance/bwg-worker-usb-0.1/fixtures.json) publishes the exact topology,
  framing facts, redacted identities, and executable reacquisition/restoration scenarios.
- [`contract.schema.json`](../../conformance/bwg-worker-usb-0.1/contract.schema.json) is the strict
  Draft 2020-12 fixture schema.
- `bwg-core/worker-controller-v02` exports the topology parser, redacted identity parsers, and pure
  session reducer.
- `bwg-core/worker-usb-conformance/fixtures` and `/schema` expose package-consumable firmware/host
  artifacts.
