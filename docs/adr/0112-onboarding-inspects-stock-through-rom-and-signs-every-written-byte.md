# ADR-0112: Onboarding inspects stock through ROM, and the package signs every byte it writes

Proposed 2026-11-11 by Ticket 04 of `.scratch/c-image-end-to-end-gate`, which built the production
onboarding device. These are the ticket's own choices, not the owner's; the owner accepts or amends
them before Ticket 15 runs onboarding on the Gamma 601. It settles what ADR-0111 left to Ticket 04
and adds to it; ADR-0101's single-port reuse is applied, not changed.

## Context

ADR-0111 made the browser the one writer, through the ROM bootloader, and the C image the reporter,
over Worker Serial. It left three things open: how the browser inspects stock ESP-Miner, which has
no Worker Serial; how a rollback to stock is checked, since `rollBack()` asks the restored image to
verify; and where a first install's C bootloader and C table come from. Building the device found a
fourth: Connect admission needs a user gesture (ADR-0094, ADR-0101), but the device must reconnect
after each reboot, minutes after the user's click.

## Decision

- **Stock is inspected from flash.** An image that answers a fresh Hello, Device Identity
  possession and `onboarding_inspect` is inspected over Worker Serial. Only an image that sends
  no Hello acknowledgment at all is inspected through ROM; one that answers Hello and then fails
  a later step stops onboarding, so a failing C image is never taken for stock. From ROM: the
  table at `0x8000`, the `otadata` selection, the running slot's `esp_app_desc_t` and NVS. The
  board is NVS `boardversion` within ADR-0104's closed set, the firmware is the descriptor's
  project name and release version, and the snapshot is never Reference Firmware
  (`upgrade_required`). The snapshot keeps the Controller capability shape, whose fixed literals
  say nothing about stock, as Ticket 14's fixtures already did; the contract types are unchanged.
- **A rollback to stock is checked from flash.** The device requires the previous slot's
  pre-install MD5 before writing anything, then writes `otadata` and NVS and reads both back.
  After the reset it waits a fixed pause and re-enters ROM, then reports the selection, the
  descriptor and its own nonce-keyed HMACs over the NVS it reads, which the state machine
  compares with the pre-install HMACs as for any rollback. This proves what flash holds, not that
  stock booted. Stock's boot is not observable over USB, so the user confirms it on the board.
- **The package signs every byte written.** The signed manifest gains
  `firstInstall: { bootloaderSha256, partitionTableSha256 }`, and the package carries the C
  bootloader and C table bytes beside the image. Admission checks both digests, that the
  bootloader fits below `0x8000`, and that the table is exactly the C table. The block joined
  `bwg-reference-firmware/0.2` before any `0.2` manifest was signed, so the profile keeps its
  identifier; Ticket 05 signs the first.
- **One gesture covers one onboarding.** The "Connect Bitaxe over USB" gesture selects the port
  (reusing one granted port, as ADR-0101 does, or Chrome's chooser). Onboarding's own Worker
  Serial sessions run the full Connect admission on that grant: the Web Lock, the device filter, a
  fresh Hello and possession. They don't repeat the gesture or foreground checks, and they can't
  open the chooser. They carry no lease, keep continuity in memory, and every session after the
  first must prove the same Device Identity. The Worker Controller's own Connect after onboarding
  is unchanged and still needs its gesture.
- **Write order.** Table check first. Then the image (checked by MD5), then, from upstream's
  table only, the C bootloader and C table (each read back), then `otadata` as `NEW`. A failure
  during the long image write leaves stock entirely untouched, and the C bootloader is in place
  before `otadata` selects the image. An interrupted bootloader write leaves a board that only ROM
  can start, which a rerun repairs.
- **esptool-js 0.7.0**, pinned exactly. Every capability needed (read, write with `keep` flash
  parameters, stub MD5, the USB-Serial-JTAG reset) is present, so no own ROM client is built. Its
  log, which includes the MAC, is discarded. The 601 sitting can refuse a board before any write
  with `maybeAdmitBaseMac`, from local configuration.

## Consequences

- The onboarding bundle grows to about 776 KB, mostly esptool-js's per-chip stub flashers.
- A board whose table, version string or board revision the browser doesn't know is refused before
  any write, including a stock build reporting a `git describe` version.
- `bootable` from flash means `factory`, `VALID` or `UNDEFINED`; a pending image is not bootable,
  matching the C image's own report.
- The bounds are proposed in `PROPOSED_ROM_ONBOARDING_BOUNDS` and measured on the 601 in a later
  sitting.

## Considered options

- **Ask the user to click again after each reboot.** Faithful to the Connect gesture rule, but an
  install has up to three reconnects, and a missed click would leave the image on trial until its
  own 120 s rollback.
- **Pin the bootloader and table digests in `bwg-core`.** Each C release would need a `bwg-core`
  release, and the owner's signature would not cover the bytes.
- **Extend the snapshot type with a stock variant.** Cleaner types, but it would change the
  admission, recovery and simulator seams that Ticket 14 just settled, for no difference in what
  is checked.
- **Restore the bytes of `otadata` read before the install.** Exact for a rollback in the same
  page, but a rollback from the download in a later page doesn't have them; recomputing from the
  target slot works in both.
