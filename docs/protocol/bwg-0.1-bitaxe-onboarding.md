# BWG Bitaxe Onboarding 0.1

## Scope

The accountless browser onboarding profile installs compatible Reference Firmware over a local USB
device selected by an explicit user action. It never writes NVS during an install, checks after
reboot that the board's settings were kept, can download a local encrypted Migration Backup, and
resumes the gate only after redacted post-reboot verification. It creates no Bright Builds account,
requires no mobile application, and contains no remote backup or flashing service. ADR-0111 records
the contract; it amends ADR-0046.

The public state machine is exported as `bwg-core/bitaxe-onboarding`; its deterministic device and
connector are isolated under `bwg-core/bitaxe-onboarding-simulator`. The shared settings vectors
are exported as `bwg-core/bitaxe-onboarding-conformance/settings-hmac-vectors`.

## Writer and partition scheme

The browser is the one writer: it drives the ROM bootloader through a pinned esptool-js. The image
adds no flash-writing command; Worker Serial carries only inspection and post-reboot proof.

Upstream ESP-Miner's table and the C image's table are scheme `esp32-factory-ota-ab`: app slots
`factory`, `ota_0` and `ota_1`, any of which may be active. An install writes `ota_0`, or `ota_1`
when `ota_0` is running, and sets `otadata` so the image boots pending; `factory` is never written.
The browser reads the table at `0x8000` and refuses anything but upstream's known table or the C
table before any write. It then writes the signed C bootloader (app rollback on) and the C table
wherever flash differs from them, and reads both back before rebooting. That covers a first install
from stock, and an install over a reference image built before Ticket 03, whose bootloader had app
rollback off. A snapshot's `rollbackAvailable`
means the previous slot stays untouched and bootable and a rollback can be driven; from stock it
holds once the known table is confirmed, since the C bootloader is written before `otadata`
selects the image.

## Explicit connection and inspection

Constructing the state machine performs no USB operation. `connect()` is the sole device-request
seam and must be invoked from a direct browser user gesture by a Web Serial integration. It reads
only the strict Worker Controller capabilities, current settings-schema version, settings
readability, and the non-secret partition facts above. Compatible Reference Firmware proceeds
without flashing; every other path remains `firmware_required` until package admission succeeds.
Inspection returns `migrationBackup: "recommended"` for a first install from stock and `"optional"`
between reference images.

## Firmware package admission

The complete manifest is authenticated by a uniquely trusted Ed25519 Update Authority key under the
`bwg-firmware-manifest+jws` compact profile. The signed payload is canonical JSON and binds:

- `bwg-reference-firmware/0.2` and the semantic firmware version (`0.1` manifests are refused);
- the exact SHA-256 image digest;
- board model and revision allowlists;
- the `esp32-factory-ota-ab` partition scheme, minimum slot size, and mandatory rollback;
- minimum/maximum readable and target settings schemas;
- the SHA-256 digests of the C bootloader and C partition table a first install writes
  (`firstInstall`); and
- a public HTTPS source URL.

The package carries the image, the bootloader and the table as bytes beside the manifest and its
signature. The bootloader must start with the ESP image magic and fit below `0x8000`; the table must
be the `0xC00`-byte region of exactly the C table. Every byte the browser can write to flash is
therefore signed. The `firstInstall` block joined the `0.2` payload before any `0.2` manifest was
signed (ADR-0112).

Unknown manifest/header fields, private JWK material, ambiguous keys, signature/payload/digest drift,
images outside the bounded browser window, oversized compact-JWS segments or compatibility lists,
incompatible boards/partitions/schema, any other partition scheme, unsupported preservation, an
unbootable current slot, unreadable settings, or unavailable rollback stop before flashing.

## Settings schema 1

Every ESP-Miner build is settings schema `1`. Before writing, the device returns the raw `nvs`
partition (at most 65,536 bytes) and its decoded entries in the `main` namespace. Each entry is
`{ key, type, value }`: `type` is an ESP-IDF `nvs_type_t` name (`u8`, `i8`, `u16`, `i16`, `u32`,
`i32`, `u64`, `i64`, `str`, `blob`), integers are canonical decimal strings, `str` is the stored
text without its terminator, and `blob` is unpadded base64url. Keys are 1 to 15 printable ASCII
characters and unique; values must fit their type.

Schema `1` names each category's exact keys, from upstream's `main/nvs_config.c`:

- `network`: `wifissid`, `wifipass`, `hostname`, `usentp`;
- `pool`: `pool_1` to `pool_8`, `prim_idx`, `sec_idx`, `usefbstartum`;
- `all`: every key in that file's settings table and the fallback keys `asicfrequency` and
  `fanspeed`, except `last_fw_fp`, `use_custom_www`, `bestdiff`, `total_uptime`,
  `cum_hashes_hi`, `cum_hashes_lo` and `scoreboard_01` to `scoreboard_20`, which the firmware
  changes itself.

The vectors file lists every key under `schemas`.

## Settings HMAC encoding (`bwg-settings-hmac/1`)

For one category, the message is the concatenation of:

1. the ASCII bytes `bwg-settings-hmac/1` and one `0x00` byte;
2. the settings schema as a 4-byte big-endian unsigned integer;
3. the ASCII category name and one `0x00` byte;
4. for each key the category names, in byte-wise ascending order, that is present: the key length
   as one byte, the ASCII key, the `nvs_type_t` code as one byte (`u8` `0x01`, `i8` `0x11`, `u16`
   `0x02`, `i16` `0x12`, `u32` `0x04`, `i32` `0x14`, `u64` `0x08`, `i64` `0x18`, `str` `0x21`,
   `blob` `0x42`), the value length as a 4-byte big-endian unsigned integer, and the value bytes.
   Integers are little-endian at their type's width, as NVS stores them; `str` is its UTF-8 bytes
   without the terminator; `blob` is its raw bytes. Absent keys are skipped, and entries the
   category doesn't name are ignored.

The category digest is HMAC-SHA-256 keyed by the 32-byte nonce, as unpadded base64url. Categories
are always listed `all`, `network`, `pool`. Upstream stores booleans as `u16` and floats as `str`,
so schema `1` entries use only `str`, `u16`, `i32` and `u64`.

`conformance/bwg-bitaxe-onboarding-0.2/settings-hmac-vectors.json` holds each message in hex and
its HMAC, refused entries, and accepted and refused verification replies. It is generated by
`node scripts/generate-bitaxe-settings-hmac-vectors.mjs`, which uses `node:crypto` and shares no
code with `web/bitaxe-settings-hmac.ts`. The C image's host tests reuse it.

## Verification, rollback copy, and backup

The browser picks one random 32-byte nonce per onboarding and passes it to every
`verifyRedactedSettings(nonce)`. The reply is exactly: `preservationConfirmed`,
`runningFirmwareVersion`, `settingsSchemaVersion`, `activeSlot`, `bootable`, `nonce` (the browser's
nonce as base64url) and `categories` (`{ category, hmacSha256 }` in order). A reply with any other
field, a plain `digestSha256`, or another nonce is refused. The browser independently inspects the
device and compares both views with the admitted package and its own HMACs over the pre-install
entries before returning `ready`. The returned evidence omits the nonce.

The raw `nvs` partition is the rollback copy. It stays in browser memory as a bounded plaintext
buffer while onboarding runs and never reaches browser storage, a service, a URL, a log, analytics,
a QR code or a support interface. Challenge credentials are never written into NVS.
`rollbackState()` is `available` while the copy exists, `backup_required` once it is wiped but a
Migration Backup was downloaded during this onboarding, and `unavailable` otherwise. `complete()`
wipes it; so does any failure and any rollback.

Any interrupted flash, reboot error, or verification mismatch rolls back at once: the device points
`otadata` at the untouched previous slot and writes the copy back, reboots, and must show the
original firmware identity, slot, schema, bootability and matching HMACs before onboarding returns
`rolled_back`. After a `ready` install, `rollBack()` does the same from the in-memory copy, or from
the user's decrypted download once the copy is wiped. If rollback or recovery verification fails,
onboarding fails and the gate cannot resume.

An optional Migration Backup encrypts the raw `nvs` partition with user-provided material of at
least 12 characters. PBKDF2 SHA-256 with 210,000 iterations derives an AES-256-GCM key using a
random 16-byte salt and 12-byte IV. Only the encrypted versioned envelope reaches the
caller-supplied local-download callback. The callback must persist or copy that borrowed buffer
before returning because onboarding wipes it on success or failure.

## Production device (Ticket 04)

`createUsbBitaxeOnboarding` builds the production `BitaxeOnboardingDevice`
(`web/rom-bitaxe-onboarding-device.ts`) on the port the user's "Connect Bitaxe over USB" gesture
grants, and `bitaxeUsbOnboardingAction` is the work gate's `maybeOnboardBitaxe` for it. ADR-0112
records the choices below.

- **One port.** The gesture selects the port (reusing a single granted port, as ADR-0101 does, or
  Chrome's chooser). ROM sessions, onboarding's Worker Serial sessions and, after onboarding is
  released, the Worker Controller's own Connect all use that grant; after a reset the device is
  re-found among the granted ports. Each ROM session holds the `bwg-worker-serial` Web Lock.
- **Inspection.** An image that answers a fresh Hello, Device Identity possession and
  `onboarding_inspect` is inspected over Worker Serial, with `capabilities` from `discover`. Two
  kinds of image are inspected from flash through ROM instead:
  - An image that sends no Hello acknowledgment at all, such as stock ESP-Miner.
  - An image that passes Hello, possession and `discover` but doesn't route `onboarding_inspect`,
    such as a reference image built before Ticket 03 (`247d2cd`). Its controller answers a command
    it doesn't route with `command_rejected`/`invalid_request`. Ticket 03's image sends that reply
    to a payload-free `onboarding_inspect` only when it has no onboarding commands. The link raises
    it as `OnboardingCommandsUnsupportedError`, and the device closes the session before entering
    ROM.

  Any other failure of possession, `discover` or `onboarding_inspect` stops onboarding with that
  error, so a failing image is never taken for stock. From flash the device reads:
  - the table;
  - the `otadata` selection;
  - the running slot's `esp_app_desc_t`: the project name, and a release version such as `v2.10.1`,
    carried as `2.10.1`;
  - the board, from NVS `boardversion` within ADR-0104's closed set.

  The snapshot is never Reference Firmware, and its preservation is `upgrade_required`. The one
  exception is an image admitted without the onboarding commands: while its slot carries the same
  descriptor, the snapshot takes the firmware and the Reference Firmware claim from that image's
  signed capabilities, because a `git describe` descriptor names no release. Its board must match
  NVS, and its preservation stays `upgrade_required`.
- **Write order.** The table is read and classified before any write. Then: the running slot's
  MD5; the image into the target slot, checked by the ROM stub's MD5; the signed C bootloader at
  `0x0` and the C table at `0x8000`, each written only where flash differs and read back byte for
  byte, and the table classified again as C's; and last `otadata`, rewritten as `esp_ota_set_boot_partition`
  does with state `NEW`, then read back. NVS is read, never written.
- **Device is back.** After the reset, the device repeats a fresh Hello and possession, then
  `onboarding_inspect` until the image reports `bootable`, which it does only after its own
  startup check marks it valid. Every Worker Serial session after the first must prove the same
  Device Identity. The window outlasts the image's 120 s startup check.
- **Rollback.** The previous slot must still have the MD5 it had before the install; a changed
  slot is refused before anything is written. Then `otadata` is pointed at the previous slot
  (`factory` erases it; an OTA slot gets the next sequence as `VALID`), the `nvs` copy is written
  back, and each is read back; each is written only when flash differs. The C bootloader and
  table stay, since they boot stock too.
- **Rollback to an image inspected from flash.** Stock has no Worker Serial, and a reference image
  from before Ticket 03 has no `onboarding_verify`. So after the reset the device waits a fixed
  pause and then inspects and verifies from flash through ROM: the selection, the app descriptor,
  and its own HMACs over the NVS it reads back, under the onboarding's nonce. This proves what
  flash holds, not that the image booted; the user checks the board's screen.
- **NVS parser.** `web/esp-nvs.ts` decodes the `main` namespace of a raw partition as ESP-IDF's
  NVS library does (written entries with a valid header CRC, the later page's copy of a key,
  multi-chunk blobs), refusing a corrupt page header or value. A rollback from the download in a
  later page can use it to check the decrypted copy.
- **Bounds.** Every step has a deadline that ends in rollback or a clear error
  (`PROPOSED_ROM_ONBOARDING_BOUNDS`). They are proposed, not yet measured on the Gamma 601.

`conformance/bwg-bitaxe-onboarding-0.2/nvs-partition-vector.json` is an NVS partition built by
ESP-IDF's own `nvs_partition_gen.py`, with the entries it must decode to.

## Verification

`bun test web/bitaxe-settings-hmac.test.ts` checks the schema 1 keys, every message and HMAC
against the shared vectors, and refused entries. `web/bitaxe-onboarding-boundaries.test.ts` covers
the scheme, the `factory` slot, refused replies and refused manifests.
`web/esp-flash-layout.test.ts` checks MD5 and the ROM CRC, the C table byte for byte against
`gen_esp32part.py`'s output, table refusals, `otadata` sequences and states, the NVS vector and
its corruptions, and app descriptors. `web/rom-bitaxe-onboarding-device.test.ts` drives the
production device on a simulated board with flash, a rollback-on bootloader, and stock, pre-Ticket 03
and C images. It covers:
- the write order, and an unknown table refused before any write;
- `otadata`;
- a rollback to stock checked from flash, and a rollback between reference images;
- ROM inspection only after no Hello, or after an admitted image without `onboarding_inspect`;
- an install over a pre-Ticket 03 image that writes the C bootloader, and its rollback checked from
  flash;
- a possession failure, or an `onboarding_inspect` error from an image that supports the command,
  that stops onboarding before any write;
- a changed previous slot refused before any write.

`web/bitaxe-usb-onboarding.test.ts` covers the one granted port, the gate action, and the mapping
of the unknown-command rejection.
`web/bitaxe-onboarding.test.ts` covers explicit USB access, signed admission, board, partition,
schema, signature and digest negatives, immutable admission inputs, single-flight installation,
bounded local encryption, undeclared secret fields, unreadable or oversized settings, interrupted
flashing and rollback recovery. `web/bitaxe-onboarding-rollback.test.ts` covers slot selection, the
nonce, HMAC mismatches, the rollback copy's lifetime, and rollback from the download. The real
Chromium journey exercises the production onboarding state machine through the component, including
fail-closed package admission. The package dry-run verifies both runtime and simulator subpaths and
the vectors are distributable. No board has been written by this device yet; Ticket 15 runs it on
the Gamma 601.
