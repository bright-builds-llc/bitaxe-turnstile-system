# Map C-image evidence onto the Core MVP

Type: task
Status: ready-for-human
Blocked by: 08, 15, 27

## Objective

Link each Core MVP criterion to its C-image evidence, or say plainly that it has
none, and bring Core Tickets 23 and 25 up to date with the Reference Firmware
switch.

## Plan

- [x] Update the spec's criteria table from Tickets 07, 08, 15, 27 and 28.
- [x] Note in Core Ticket 23 that its Rust evidence is historical and link the
  C-image evidence for each item.
- [x] Add the C-image evidence and its non-claims to Core Ticket 25.

## Comments

- 2026-11-14, owner: Ticket 29 no longer blocks this ticket. Criterion 11 doesn't list the
  handover, and a handed-over grant never reaches the other board through the page. Map the
  handover to the rehearsal (two profiles, the real lock), `negative-cases.json` and the C host
  tests (`test_lease_auth.c`), with "not run on hardware" as a non-claim unless Ticket 29 has run.
- 2026-11-15, done, for the owner's review:
  - `spec.md`'s criteria table now links each criterion to Tickets 07, 08, 15, 27 and 28 and
    the C repository's evidence page at `2bb93f0`. Criteria 1, 2, 3, 6, 7, 8 and 9 have
    C-image evidence with their limits named; 4, 5, 10, 11 and 13 are partial; 12 isn't a
    firmware criterion. The handover maps to the rehearsal, `negative-cases.json` and
    `test_lease_auth.c`, with "not run on hardware", as the owner asked.
  - Core Ticket 23 now says its Rust evidence is historical and ends with a C-image table, item
    by item: seven resolved, the withheld, expired-context and cross-possession item and the
    BIP 23 item partly resolved, and the other-identity item open on hardware.
  - Core Ticket 25 has the C-image summary against its items, and the non-claims.
