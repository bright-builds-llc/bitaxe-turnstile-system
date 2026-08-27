# BWG Bitaxe Onboarding 0.1

## Scope

The accountless browser onboarding profile installs compatible Reference Firmware over a local USB
device selected by an explicit user action. It preserves admitted NVS settings by default, can
download a local encrypted Migration Backup, and resumes the gate only after redacted post-reboot
verification. It creates no Bright Builds account, requires no mobile application, and contains no
remote backup or flashing service.

The public state machine is exported as `bwg-core/bitaxe-onboarding`; its deterministic device and
connector are isolated under `bwg-core/bitaxe-onboarding-simulator`.

## Explicit connection and inspection

Constructing the state machine performs no USB operation. `connect()` is the sole device-request
seam and must be invoked from a direct browser user gesture by a Web Serial integration. It reads
only the strict Worker Controller capabilities, current settings-schema version, settings
readability, and non-secret A/B partition/rollback facts. Compatible Reference Firmware proceeds
without flashing; every other path remains `firmware_required` until package admission succeeds.

## Firmware package admission

The complete manifest is authenticated by a uniquely trusted Ed25519 Update Authority key under the
`bwg-firmware-manifest+jws` compact profile. The signed payload is canonical JSON and binds:

- `bwg-reference-firmware/0.1` and the semantic firmware version;
- the exact SHA-256 image digest;
- board model and revision allowlists;
- the `esp32-ota-ab` partition scheme, minimum slot size, and mandatory rollback;
- minimum/maximum readable and target settings schemas; and
- a public HTTPS source URL.

Unknown manifest/header fields, private JWK material, ambiguous keys, signature/payload/digest drift,
images outside the bounded browser window, oversized compact-JWS segments or compatibility lists,
incompatible boards/partitions/schema, unsupported preservation, an unbootable current slot,
unreadable settings, or unavailable rollback stop before flashing.

## Preservation, backup, and recovery

The device returns at most 65,536 bytes of admitted migration settings. The browser keeps bounded
plaintext buffers, derives a complete-settings SHA-256 digest plus redacted `network` and `pool`
category evidence, and wipes its migration buffer after the device has copied it or any failure
occurs. Challenge credentials are never written into this persistent settings payload.

An optional Migration Backup requires user-provided material of at least 12 characters. PBKDF2
SHA-256 with 210,000 iterations derives an AES-256-GCM key using a random 16-byte salt and 12-byte
IV. Only the encrypted versioned envelope reaches the caller-supplied local-download callback. The
callback must persist or copy that borrowed buffer before returning because onboarding wipes it on
success or failure; no service, URL, log, analytics, QR, or support interface receives plaintext or
ciphertext.

After flash and reboot, the device returns strict non-secret proof: preservation status, running
firmware and settings-schema versions, active slot, bootability, rollback state, and the complete,
network, and pool category hashes. The browser independently inspects the device and compares both
views with its admitted package and pre-flash evidence before returning `ready`. Any interrupted
flash, reboot error, or verification mismatch invokes the rollback slot, reboots again, and requires
the original firmware identity, slot, schema, bootability, and matching redacted evidence before
returning `rolled_back`. If rollback or recovery verification fails, onboarding fails and the gate
cannot resume.

## Verification

`bun test web/bitaxe-onboarding.test.ts` covers explicit USB access, signed admission, board,
partition, schema, signature and digest negatives, immutable admission inputs, single-flight
installation, default preservation, bounded local encryption, undeclared secret fields,
unreadable/oversized settings, interrupted flashing, redacted verification, and rollback recovery.
The real Chromium journey exercises the production onboarding state machine through the component,
including fail-closed package admission. The package dry-run verifies both runtime and simulator
subpaths are distributable.
