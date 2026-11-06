# C image reports onboarding facts and guards its own boot

Type: task
Status: ready-for-agent
Blocked by: 02, 14

## Objective

Implement the C image's half of Ticket 02's contract in `bitaxe-esp-miner-c`,
against Ticket 14's vectors. The work and its tests land in that repository under
its own rules (host tests, upstream hooks listed in its `AGENTS.md`). This ticket
records the result and the commit. The image adds no flash-writing command; the
browser writes through the ROM bootloader (Ticket 04).

## Plan

- [ ] Firmware ticket opened in the C repository and linked here.
- [ ] `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE` on. The image marks itself valid only
  after its startup check (the Gate's link is up and NVS reads back cleanly),
  replacing upstream's unconditional mark-valid in `main/main.c`. A host or QEMU
  test shows a failed check rolling back.
- [ ] The C partition table moves coredump to the end of flash.
- [ ] Inspection over Worker Serial: settings schema `1`, partition scheme, active
  slot and rollback state.
- [ ] Post-reboot verify answers with category HMACs keyed by the browser's nonce,
  passing Ticket 14's vectors.
- [ ] Bounds chosen under Ticket 02's rules and measured on the 601, recorded here.
- [ ] The Worker Serial manifest digest confirmed as `a43c2c7d61f95fc6`, so the 205
  and 601 capabilities need no new signatures.
- [ ] The mark-valid change prepared as an upstream offer; the owner opens it.

## Comments
