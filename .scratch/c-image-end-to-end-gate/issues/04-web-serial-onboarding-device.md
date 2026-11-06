# Browser onboarding device over the ROM bootloader

Type: task
Status: ready-for-agent
Blocked by: 03

## Objective

Add a production `BitaxeOnboardingDevice` that writes through the ROM bootloader
with esptool-js and inspects and verifies the C image over Worker Serial, so
`bwg-core/bitaxe-onboarding` can install on a real board from stock ESP-Miner or
from an earlier reference image. Today only `web/simulated-bitaxe-onboarding.ts`
implements it.

## Plan

- [ ] esptool-js pinned to an exact version. Replace it with our own ROM client
  only if a capability we need is proven missing, or if our own would be much more
  useful (the owner's rule).
- [ ] Read the partition table at `0x8000`, and refuse anything but upstream's known
  table or the C table before any write. From stock, write the C bootloader and C
  table once and read both back before rebooting.
- [ ] Read the raw `nvs` partition through ROM, keep it in memory as Ticket 14
  says, offer the optional Migration Backup download, and parse it in JS for the
  nonce-keyed HMAC digests.
- [ ] Write the image to the inactive slot and set `otadata` to boot it pending.
  NVS is never written, except when a rollback restores the backup.
- [ ] After mark-valid, `rollback()` points `otadata` at the untouched previous slot
  and writes the backup back. Say how a rollback to stock, which has no Worker
  Serial, is checked.
- [ ] "Device is back" is a fresh Hello plus proof of possession on the new image.
  Bounds chosen under Ticket 02's rules and measured on the 601, recorded here.
- [ ] Reuse one granted port across ROM, onboarding and the Worker Controller
  (ADR-0101), wire the component's "Connect Bitaxe over USB" path, and run
  `bun run verify`.

## Comments
