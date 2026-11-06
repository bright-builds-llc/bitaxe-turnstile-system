# Authority judges a Work Event by the reading at which it was observed

Type: task
Status: ready-for-agent
Blocked by: 10

## Objective

The Authority stops a Work Session when a delivered Accepted Work Event's lease
reading is lower than the last reading it recorded. A Renew records a newer
reading. So a share the Pool Adapter observed before a Renew but delivered after
it looks like a monotonic reset and ends the lease.

A related failure: accepted work writes its reading into the same column that
Start and Renew own. A share observed after the renewal hint but before the
Renew breaks the leased-session shape constraint and can't be recorded at all.

## Plan

- [ ] A failing test reproduces delivery after a Renew.
- [ ] The Authority judges each event by the lease window, its continuity and
  the highest reading among accepted events, not by the last Renew.
- [ ] A reading that really runs backwards stays refused: below the lease start,
  below an earlier accepted event, or under another continuity.
- [ ] Replayed events and duplicate shares still earn no second credit.
- [ ] Renew keeps refusing a reading below either recorded reading.

## Comments
