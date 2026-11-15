# Map C-image evidence onto the Core MVP

Type: task
Status: ready-for-agent
Blocked by: 08, 15, 27

## Objective

Link each Core MVP criterion to its C-image evidence, or say plainly that it has
none, and bring Core Tickets 23 and 25 up to date with the Reference Firmware
switch.

## Plan

- [ ] Update the spec's criteria table from Tickets 07, 08, 15, 27 and 28.
- [ ] Note in Core Ticket 23 that its Rust evidence is historical and link the
  C-image evidence for each item.
- [ ] Add the C-image evidence and its non-claims to Core Ticket 25.

## Comments

- 2026-11-14, owner: Ticket 29 no longer blocks this ticket. Criterion 11 doesn't list the
  handover, and a handed-over grant never reaches the other board through the page. Map the
  handover to the rehearsal (two profiles, the real lock), `negative-cases.json` and the C host
  tests (`test_lease_auth.c`), with "not run on hardware" as a non-claim unless Ticket 29 has run.
