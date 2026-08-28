# BWG Worker Controller 0.2

## Scope

`bwg-worker-controller/0.2` preserves the bounded Work Lease and Mining Baseline semantics of
Controller 0.1 while binding real Reference Firmware to the separated
`bwg-worker-usb/0.1` application transport. The higher-level `WorkerController` interface remains
the client seam; physical USB permission, function admission, transfers, reacquisition, and
disconnect stay inside adapters.

Controller 0.2 does not add remote management, persistent pool settings, a shell, Device Identity
pairing, Gate Authority behavior, or new mining economics.

## Capability discovery

The strict 0.2 capability shape differs from 0.1 in exactly two transport facts:

- `board.usbTransport` is `web_usb`; and
- `transportProfile` is `bwg-worker-usb/0.1`.

Board model/revision, firmware name/version, Reference Firmware status, Work Lease support, Mining
Baseline restoration support, and settings-preservation compatibility retain their 0.1 meaning.
Unknown fields and secret-bearing extensions remain invalid.

Capability discovery also carries `attestation`: canonical
`bwg-reference-firmware-capability/0.1` claims plus a compact Ed25519 Update Authority JWS. The
signature binds protocol, board, firmware, compatibility, transport profile, and the SHA-256 digest
of the exact application USB descriptor. Admission requires one uniquely trusted strict Update
Authority key, a valid signature, an exact descriptor digest, and the separately observed physical
Worker identity/reacquisition checks. A self-asserted `referenceFirmware: true` flag is never
sufficient.

## Work Lease semantics

Start and renewal preserve the 0.1 limits and full-input authentication requirements:

- exclusive duration is 1 through 60,000 milliseconds;
- the renewal hint is 1 through 20,000 milliseconds and strictly before expiry;
- authorization binds the exact Lease ID, Challenge ID, Stratum configuration, and deadlines; and
- device wall time never authorizes or extends work.

Status remains metadata-only. It exposes monotonic time, opaque challenge/lease IDs, deadlines,
state, and a closed restoration status/reason without authorization, Stratum credentials, or
captured Mining Baseline settings.

## Control framing

Controller requests and responses retain the bounded UTF-8 JSON-plus-LF representation from 0.1,
but each complete frame crosses only the vendor-specific WebUSB control function in one bulk
transaction. A frame is non-empty and at most 65,536 bytes. Multiple lines, malformed UTF-8/JSON,
unknown fields or commands, wrong versions, mismatched IDs, log injection, and secret-bearing error
text fail closed.

Commands remain `discover`, `start_lease`, `renew_lease`, `status`, `pause`, `cancel`, and
`restore`. Credentials are permitted only inside bounded authenticated Start/Renew control
transfers and volatile implementations. They never belong in logs, evidence, errors, telemetry,
ordinary pool configuration, or public state.

## Possession-bound successor

Controller 0.2 remains an unchanged compatibility profile bound to `bwg-worker-usb/0.1`; it cannot
be widened to carry a possession protocol. Production Reference Firmware advances to Controller
0.3 and Worker USB 0.2, which add a separate fresh-nonce Local Device Possession Proof before Work
Lease control while preserving these Work Lease semantics.

## Version relationship

Controller 0.1 remains a valid simulator and Web Serial profile for existing consumers. Controller
0.2 remains its additive separated-control compatibility successor. Possession-bound production
firmware uses Controller 0.3; implementations must not accept an earlier capability or payload as a
later profile merely by changing a version string.

## Conformance artifacts

- [`fixtures.json`](../../conformance/bwg-worker-controller-0.2/fixtures.json) publishes exact
  signed capability, trusted fixture key, grant, renewal, strict status, every command, typed error,
  correlation, size-boundary, malformed-transfer, and log-injection vector.
- [`contract.schema.json`](../../conformance/bwg-worker-controller-0.2/contract.schema.json) is the
  strict Draft 2020-12 fixture schema.
- `bwg-core/worker-controller-v02` exports the runtime parsers and control-frame codec.
- `bwg-core/worker-controller-v02-conformance/fixtures` and `/schema` expose package-consumable
  cross-repository artifacts.
