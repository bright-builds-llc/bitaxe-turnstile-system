# C image serves onboarding inspection and install

Type: task
Status: ready-for-agent
Blocked by: 02

## Objective

Implement Ticket 02's contract in `bitaxe-esp-miner-c`. The work and its tests
land in that repository under its own rules (host tests, upstream hooks listed
in its `AGENTS.md`). This ticket records the result and the commit.

## Plan

- [ ] Firmware ticket opened in the C repository and linked here.
- [ ] Inspection, settings read, image write, reboot and proof commands, with
  host tests and QEMU tests.
- [ ] App rollback per Ticket 02, proven by a host or QEMU test of a failed boot.
- [ ] The Worker Serial manifest digest recorded, and whether it changed.

## Comments
