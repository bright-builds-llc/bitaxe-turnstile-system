# 01: Aggregate exact work across concurrent and successive sessions

**What to build:** One Work Challenge accepts exact deduplicated contributions from several
concurrent or successive Work Sessions without transferring progress into a session aggregate.

**Blocked by:** None. BWG Core Tickets 10, 11, and 15 are resolved.

**Status:** ready-for-agent

- [ ] Several live Work Sessions can be registered for one eligible Work Challenge with distinct
  session credentials, targets, and event identities.
- [ ] Accepted Work Events from concurrent and successive sessions accumulate in the existing exact
  challenge-scoped Credited Work ledger across restart.
- [ ] Event replay, event-identity conflict, and share-fingerprint reuse across any two sessions
  cannot add progress twice.
- [ ] Expiring, failing, or disconnecting one session cannot subtract, transfer, or recalculate
  already accepted progress.
- [ ] Concurrent threshold-crossing delivery creates one stable issuance intent and never
  overflows or issues twice.
