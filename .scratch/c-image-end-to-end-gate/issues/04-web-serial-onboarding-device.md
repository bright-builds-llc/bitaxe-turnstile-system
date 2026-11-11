# Browser onboarding device over the ROM bootloader

Type: task
Status: ready-for-human
Blocked by: 03

## Objective

Add a production `BitaxeOnboardingDevice` that writes through the ROM bootloader
with esptool-js and inspects and verifies the C image over Worker Serial, so
`bwg-core/bitaxe-onboarding` can install on a real board from stock ESP-Miner or
from an earlier reference image. Today only `web/simulated-bitaxe-onboarding.ts`
implements it.

## Plan

- [x] esptool-js pinned to an exact version. Replace it with our own ROM client
  only if a capability we need is proven missing, or if our own would be much more
  useful (the owner's rule).
- [x] Read the partition table at `0x8000`, and refuse anything but upstream's known
  table or the C table before any write. From stock, write the C bootloader and C
  table once and read both back before rebooting.
- [x] Read the raw `nvs` partition through ROM, keep it in memory as Ticket 14
  says, offer the optional Migration Backup, and parse it in JS for the
  nonce-keyed HMAC digests.
- [x] Write the image to the inactive slot and set `otadata` to boot it pending.
  NVS is never written, except when a rollback restores the backup.
- [x] After mark-valid, `rollback()` points `otadata` at the untouched previous slot
  and writes the backup back. Say how a rollback to stock, which has no Worker
  Serial, is checked.
- [x] "Device is back" is a fresh Hello plus proof of possession on the new image.
  Bounds chosen under Ticket 02's rules.
- [ ] Bounds measured on the 601, recorded here.
- [x] Reuse one granted port across ROM, onboarding and the Worker Controller
  (ADR-0101), wire the component's "Connect Bitaxe over USB" path, and run
  `bun run verify`.

## Answer

Built on 2026-11-11 on branch `claude/ticket-04-rom-onboarding-5104de`, against
`bitaxe-esp-miner-c` `51e5af9`. Nothing was written to a board: the 601 was unplugged,
and every test drives a simulated board. ADR-0112 records the choices, as proposed: they
are this ticket's, not the owner's, and the owner accepts or amends them before Ticket 15.

- **Device.** `RomBitaxeOnboardingDevice` (`web/rom-bitaxe-onboarding-device.ts`) composes
  a ROM seam and a Worker Serial seam (`web/rom-onboarding-seams.ts`).
  `createUsbBitaxeOnboarding` builds it on Web Serial, and `bitaxeUsbOnboardingAction` is
  the work gate's `maybeOnboardBitaxe` (`web/bitaxe-usb-onboarding.ts`). Both are exported
  from `bwg-core/bitaxe-onboarding`. The flash formats are pure modules, checked against
  ESP-IDF v6.0.2's own source and tools: `esp-partition-table.ts`, `esp-otadata.ts`,
  `esp-nvs.ts`, `esp-app-image.ts` and `esp-flash-digests.ts` (MD5 and the ROM CRC).
- **esptool-js 0.7.0**, pinned exactly (`web/esptool-rom-access.ts`). It has every
  capability needed: read, write with `keep` flash parameters (so the signed bootloader is
  written unchanged), the stub's MD5, and the USB-Serial-JTAG reset. No own ROM client was
  built. Its log, which includes the MAC, is discarded. An optional `maybeAdmitBaseMac`
  refuses a board before any write, for the sitting's base-MAC match.
- **Table check.** The `0xC00` region at `0x8000` must equal upstream's or the C table row
  for row, with a matching MD5 row and nothing after it. The encoder matches the C build's
  `partition-table.bin` byte for byte. Anything else is refused at `readMigrationSettings`,
  before `flash`, so the install throws without writing.
- **Write order.** Table check, then the running slot's MD5, then the image into the target
  slot (checked by the stub's MD5). From upstream's table only, the C bootloader at `0x0`
  and the C table at `0x8000` follow, each read back byte for byte, and the table is
  classified again as C's. `otadata` comes last, rewritten as `esp_ota_set_boot_partition`
  does, with `NEW`, and read back. The image goes first, so a failed long write leaves stock
  untouched. NVS is only read.
- **The bytes come signed.** The manifest gains `firstInstall: { bootloaderSha256,
  partitionTableSha256 }`, and the package carries the bootloader and table beside the
  image. Admission checks both digests, a bootloader below `0x8000` and exactly the C
  table. It joined profile `0.2` before any `0.2` manifest was signed. **Ticket 05 must
  include both files.**
- **Settings.** The raw `nvs` partition is read through ROM and kept in memory by Ticket
  14's state machine. The Migration Backup stays optional. `parseNvsPartition` decodes the
  `main` namespace as ESP-IDF's NVS library does, and is checked against a partition built
  by ESP-IDF's `nvs_partition_gen.py`
  (`conformance/bwg-bitaxe-onboarding-0.2/nvs-partition-vector.json`, test values only).
- **Inspecting stock.** An image that answers a fresh Hello, possession and
  `onboarding_inspect` is inspected over Worker Serial. Any other image is inspected from
  flash: the `otadata` selection, the running slot's `esp_app_desc_t` (a release version
  such as `v2.10.1` becomes `2.10.1`; a `git describe` suffix is refused), and the board
  from NVS `boardversion` within ADR-0104's set. Such an image is never Reference
  Firmware.
- **Device is back.** After the reset, the device runs a fresh Hello and possession, then
  `onboarding_inspect` until the image reports `bootable`, which it does only after its
  startup check. It retries until the deadline, and every session after the first must
  prove the same Device Identity. It waits past the image's 120 s check; otherwise the
  install rolls back.
- **Rollback.** `otadata` points at the previous slot: `factory` erases it, and an OTA slot
  gets the next sequence as `VALID`. The `nvs` copy is written back. Each is read back, and
  each is written only when flash differs. The previous slot must still have its
  pre-install MD5. The C bootloader and table stay, since they boot stock too.
- **Rollback to stock.** Stock has no Worker Serial. After the reset the device waits a
  fixed pause, re-enters ROM, and reports the selection, the descriptor and its own
  nonce-keyed HMACs over the NVS it reads back. The state machine compares these with the
  pre-install HMACs. This proves what flash holds, not that stock booted, so the user
  confirms stock on the board's screen.
- **One port.** The gesture selects the port (one granted port is reused, or Chrome's
  chooser opens). ROM sessions hold the `bwg-worker-serial` Web Lock. Onboarding's Worker
  Serial sessions run the full admission on that grant, but can't open the chooser and skip
  the gesture check: one gesture covers one onboarding (ADR-0112). After release, the
  Worker Controller's own Connect reuses the grant under ADR-0101. The C image's two
  commands are `onboardingInspect` and `onboardingVerify` on the browser controller.
- **Wiring.** `bitaxeUsbOnboardingAction` fits `WorkGateConfiguration["maybeOnboardBitaxe"]`
  and is tested against that type. No deployed page passes it yet: the reference page
  connects its Worker before it configures the gate, and there is no signed package until
  Ticket 05. Ticket 15 wires a page.
- **Tests.** `web/esp-flash-layout.test.ts` (21), `web/rom-bitaxe-onboarding-device.test.ts`
  (13), on a fake board with flash, a rollback-on bootloader, stock and the C image, and
  `web/bitaxe-usb-onboarding.test.ts` (8). They cover table checks, write order,
  `otadata`, the backup and rollback. Two admission tests in `web/bitaxe-onboarding.test.ts`
  refuse a bootloader off its digest and a signed table that isn't C's.

### Proposed bounds (not measured)

Chosen under Ticket 02's rules: every step has a deadline, and each one ends in rollback or
a clear error. They live in `PROPOSED_ROM_ONBOARDING_BOUNDS`. None is measured.

| Step | Proposed | Why |
| --- | --- | --- |
| Hello and possession, and each `onboarding_inspect` or `onboarding_verify` | 10 s | Admission and one reply on an idle board |
| ROM entry (reset, sync, stub) | 15 s | esptool-js's own reset attempts, with margin |
| One flash read (table, `otadata`, descriptor, 24 KiB NVS) | 15 s | Small reads through the stub |
| One small write with read-back (bootloader, table, `otadata`, NVS) | 20 s | Under 32 KiB each |
| Image write with MD5 check | 240 s | About 3 MB compressed over USB-Serial-JTAG |
| MD5 of a whole 4 MiB slot | 60 s | esptool-js allows 8 s per MiB |
| Device back: reset until `bootable` | 180 s | Past the image's 120 s startup check (Ticket 03), with margin |
| Pause between reconnect attempts | 2 s | |
| Pause after resetting into stock (unobserved) | 10 s | |
| Port re-found among granted ports after a reset | 10 s | Re-enumeration of native USB |

### Left for the 601 sitting

Run under the fork handoff's process rules, with a base-MAC match before any ROM write.

- Measure every bound above, from stock and between reference images, and record them
  here.
- Confirm that the native USB keeps or re-finds its grant across the ROM reset and the hard
  reset, and that closing the port after the hard reset doesn't reject.
- Confirm that the C bootloader boots stock `factory` under the C table, and that a real
  bootloader rollback (a reset before mark-valid) returns to the previous slot.
- Check that the browser's HMACs over the 601's NVS read through ROM equal the C image's
  over Worker Serial.
- Check upstream's table on the board equals `KNOWN_PARTITION_TABLES.upstream`, and read
  which slot the 601 runs from.

### Left for the owner

- Accept or amend ADR-0112. One choice needs the owner most: onboarding's own reconnects
  skip the Connect gesture check, though they keep the full admission.
- Licensing before distribution. esptool-js is Apache-2.0 and is bundled into
  `dist/bitaxe-onboarding`, which also embeds its per-chip ROM stub flasher binaries. Their
  upstream origin and licence weren't checked here, and `bwg-core` is MIT.

## Comments

- 2026-11-11: built the production device, the ROM flash formats, the signed first-install
  bytes and the gate action, on simulated boards only. What remains is the 601 sitting
  above, then Ticket 05's signed package with the bootloader and table, then Ticket 15.
