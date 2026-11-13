# Onboarding on the 601, from stock and between reference images

Type: task
Status: ready-for-human
Blocked by: 05

## Objective

Prove onboarding on a real Gamma 601 with the owner's signed package, apart from
the first Gate (07). This is criterion 3's evidence for Ticket 09.

## Plan

- [ ] Stock ESP-Miner installs the signed C package. The category digests match
  before and after, and the device comes back with a fresh Hello and proof of
  possession.
- [ ] A reference-to-reference update installs a newer signed package the same way.
- [ ] A board on a reference image from before Ticket 03 (`247d2cd`, which both boards run)
  installs the package. It is admitted, inspected from flash, gets the C bootloader, and is
  verified over Worker Serial. A rollback returns to `247d2cd`, and is checked from flash.
- [ ] A board with any other partition table is refused before anything is written.
- [ ] A failed startup check rolls back in the bootloader before mark-valid, and a
  browser-driven rollback after it returns to the previous slot with NVS restored.
- [ ] Evidence names the board, commits, image and ELF digests, timings and
  non-claims, and holds nothing private. The Migration Backup never leaves the
  browser.

## Comments
- 2026-11-13 (from Ticket 05's review): a 601 still on `247d2cd` is now an onboarding path of
  its own (see Ticket 04's comment).
  - It is admitted over Worker Serial and refuses `onboarding_inspect` as an unknown command.
  - It is inspected from flash, with the firmware from its signed capability.
  - The install also writes the C bootloader, because `247d2cd`'s has app rollback off.
  - On the board, confirm that the controller's reply really is `command_rejected`/`invalid_request`,
    and that the session ends after it.
  - An interrupted bootloader write on such a board can't be repaired from the browser. Esptool
    repairs it (ADR-0112).
