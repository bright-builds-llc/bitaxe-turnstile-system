# BWG Worker Controller / USB 0.1

## Scope

`bwg-worker-controller/0.1` is the accountless local boundary between a Reference Client and one
compatible Worker. It lets the client discover non-secret compatibility, start and renew one
bounded challenge Work Lease, observe status, and request Mining Baseline restoration. It is not a
remote shell, persistent pool-settings API, Device Identity ceremony, or Gate Authority protocol.

The gate repository owns this contract, its shared fixtures, the browser-facing TypeScript
interface, and the simulator. Reference Firmware implements the same fixtures in its repository.

## USB framing

- The transport is request/response UTF-8 JSON Lines: exactly one JSON object followed by one LF.
- A frame is non-empty and at most 65,536 bytes. Multiple objects, invalid UTF-8, unknown commands,
  unsupported versions, unexpected fields, and mismatched response IDs fail closed.
- Every envelope carries `protocolVersion: "bwg-worker-controller/0.1"` and an opaque bounded
  `requestId`. Responses repeat that ID and contain exactly one of `result` or a metadata-only
  `error`.
- The browser adapter accepts an injected frame exchange. A Web Serial implementation can supply
  that exchange only after a direct user gesture; neither the headless SDK nor simulator depends on
  browser-specific `SerialPort` state.

Commands are `discover`, `start_lease`, `renew_lease`, `status`, `pause`, `cancel`, and `restore`.
Credential-bearing start and renewal payloads are transient inputs. Responses and errors never echo
authorization, Stratum username/password, Mining Baseline settings, Wi-Fi, payout data, private
keys, or Device Identity.

## Capability discovery

Discovery reports only board model/revision, `web_serial` compatibility, firmware name/version,
Reference Firmware status, Work Lease and Mining Baseline support, and one settings-preservation
category: `compatible`, `upgrade_required`, or `unsupported`.

All public objects reject unknown fields. Implementations must not append credentials, serial
numbers, Wi-Fi configuration, ordinary pool settings, private keys, or persistent Device Identity
to discovery, status, restoration confirmation, or errors.

## Work Lease rules

A start grant binds an opaque Lease ID and Challenge ID to authenticated, short-lived Stratum
configuration. `durationMilliseconds` is an integer from 1 through 60,000. A renewal hint is an
integer from 1 through 20,000 and strictly less than the duration. Renewal repeats the exact active
Lease ID and supplies fresh authentication.

The `authorization` value and complete normalized grant/renewal are inputs to the controller's
required lease-verification port; non-empty syntax alone never authorizes work. Authentication must
bind the Challenge ID, Lease ID, Stratum configuration, and deadline values. The deterministic
simulator therefore requires an injected full-input verifier and includes tampering and invalid-auth
vectors. Concrete signing/key provisioning is deployment-owned and cannot relax duration,
continuity, or restoration rules.

The Worker captures its Mining Baseline before applying challenge configuration. It converts the
accepted duration and renewal hint into local monotonic deadlines; device wall time is not used for
lease enforcement. Status exposes only IDs, monotonic deadlines, and the redacted state.

The Worker autonomously observes its monotonic clock and boot/control continuity rather than
waiting for status polling. It restores the captured baseline and removes challenge credentials on Pause, Cancel,
exclusive lease expiry, challenge satisfaction/expiry, reboot, monotonic reset, lost continuity,
tab closure, or connectivity loss. No old lease resumes after reboot or continuity loss. A fresh
authenticated grant may start only after restoration. `restoration.status: "confirmed"` and its
closed reason category are the public confirmation; raw restored settings are never returned.

## Headless client composition

`createHeadlessClient` optionally accepts the public `WorkerController` interface. Discovery occurs
through that interface. Authority transport Start/resume returns the authenticated Worker Lease;
the SDK forwards it to the controller, renews through both public seams, and composes Pause/Cancel
with baseline restoration. Terminal Authority lifecycle events request restoration before exposing
the terminal client state. USB disconnect pauses the Authority after device-local restoration, and
async client cleanup requests `tab_closed` restoration. Existing non-device clients may omit the
controller.

The runtime interface and USB adapter are exported as `bwg-core/worker-controller`. The deterministic
clock, simulated controller, and simulated USB exchange are isolated under
`bwg-core/worker-controller-simulator`; production headless/component bundles do not include them.

## Shared conformance artifacts

- [`fixtures.json`](../../conformance/bwg-worker-controller-0.1/fixtures.json) contains canonical
  capability/lease inputs and executable operation/clock/error/outcome vectors.
- [`contract.schema.json`](../../conformance/bwg-worker-controller-0.1/contract.schema.json) is the
  strict Draft 2020-12 fixture schema.
- `bun test web/worker-controller*.test.ts web/headless-worker-controller.test.ts` runs the simulator,
  actual USB codec/adapter, monotonic failure scenarios, privacy checks, and headless composition.

These artifacts ship in the npm package so firmware CI can consume a released profile without
depending on this repository's implementation internals.

Package consumers import the vectors from `bwg-core/worker-controller-conformance/fixtures` and the
schema from `bwg-core/worker-controller-conformance/schema`.

## Application transport follow-up

This 0.1 profile remains the strict simulated and Web Serial contract; it is not evidence that real
Reference Firmware may mix controller frames with its runtime log transport. The
[`bwg-worker-usb-separation`](../../.scratch/bwg-worker-usb-separation/spec.md) child effort owns the
additive Controller 0.2 and `bwg-worker-usb/0.1` profiles for separated application WebUSB control,
receive-only CDC evidence, and bootloader/application Transport Reacquisition. Controller 0.1
fixtures and package exports remain valid for existing consumers while real Reference Firmware
eligibility moves to the new profiles.
