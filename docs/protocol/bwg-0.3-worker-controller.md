# BWG Worker Controller 0.3

## Scope

`bwg-worker-controller/0.3` preserves the bounded Work Lease and Mining Baseline semantics of
Controller 0.2 while binding real Reference Firmware to the separated
`bwg-worker-usb/0.2` application transport. The higher-level `WorkerController` interface remains
the client seam; physical USB permission, function admission, transfers, reacquisition, and
disconnect stay inside adapters.

Controller 0.3 does not add remote management, persistent pool settings, a shell, Device Identity
pairing, Gate Authority behavior, or new mining economics.

## Capability discovery

The strict 0.3 capability preserves Controller 0.2 semantics while changing two profile facts:

- `board.usbTransport` is `web_usb`; and
- `transportProfile` is `bwg-worker-usb/0.2`.

Board model/revision, firmware name/version, Reference Firmware status, Work Lease support, Mining
Baseline restoration support, and settings-preservation compatibility retain their earlier meaning.
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

Production deployment authorization uses the separate
[`bwg-worker-deployment-trust/0.1`](./bwg-worker-deployment-trust-0.1.md) profile inside the
existing opaque `authorization` string. Controller 0.3's shape and 512-byte authorization bound do
not change. The signed request digest binds every authorizationless field, active Challenge, fresh
Device Identity-bound control-session context, and durable monotonic authority sequence.

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

## Possession prerequisite

Worker USB 0.2 admits a separate `bwg-worker-possession/0.1` frame before Controller 0.3 Work Lease
control. The client verifies a fresh-nonce Device Identity proof bound to the active challenge,
this exact signed capability, and the application descriptor. USB serial, VID/PID, enumeration
identity, and their hashes cannot satisfy this prerequisite.

## Browser WebUSB adapter

`createWebUsbWorkerControllerV03` performs no construction-time USB effect. Its explicit
permission method requests one deployment-filtered device while browser user activation is live,
admits the exact USB 0.2 function, verifies capability and possession, and only then enables the
stable high-level Controller methods. It returns redacted initial/recovered connection state rather
than Device Identity or USB values.

The adapter stores only a challenge-binding digest, Device Identity fingerprint, and exclusive
retention expiry in a separate `bwg-worker` IndexedDB database. Recovered tabs must re-prove the
same key and a baseline state; terminal cancellation, satisfaction, or expiry deletes the record.
The fingerprint-bearing store is internal to the trusted application origin and is not a package
interface, UI value, backend field, export, log, or telemetry value. Same-origin script compromise
is not protected by browser storage isolation.
Disconnect and response-loss paths require a new enumeration, same-key proof, exact restoration
reason, and successful host disconnect handling before control becomes ready.

## Version relationship

Controller 0.1 remains the existing simulator and Web Serial profile. Controller 0.2 and Worker USB
0.1 remain separated-control compatibility profiles. Possession-bound production firmware uses
Controller 0.3 and Worker USB 0.2; implementations must not accept an earlier capability or payload
as a later profile merely by changing a version string.

## Conformance artifacts

- [`fixtures.json`](../../conformance/bwg-worker-controller-0.3/fixtures.json) publishes exact
  signed capability, trusted fixture key, grant, renewal, strict status, every command, typed error,
  correlation, size-boundary, malformed-transfer, and log-injection vector.
- [`contract.schema.json`](../../conformance/bwg-worker-controller-0.3/contract.schema.json) is the
  strict Draft 2020-12 fixture schema.
- `bwg-core/worker-controller-v03` exports the runtime parsers and control-frame codec.
- `bwg-core/worker-controller-v03-conformance/fixtures` and `/schema` expose package-consumable
  cross-repository artifacts.
