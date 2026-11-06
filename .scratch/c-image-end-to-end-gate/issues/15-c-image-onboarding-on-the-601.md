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
- [ ] A board with any other partition table is refused before anything is written.
- [ ] A failed startup check rolls back in the bootloader before mark-valid, and a
  browser-driven rollback after it returns to the previous slot with NVS restored.
- [ ] Evidence names the board, commits, image and ELF digests, timings and
  non-claims, and holds nothing private. The Migration Backup never leaves the
  browser.

## Comments
