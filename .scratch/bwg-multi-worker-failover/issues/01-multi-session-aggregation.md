# 01: Aggregate exact work across concurrent and successive sessions

**What to build:** One Work Challenge accepts exact deduplicated contributions from several
concurrent or successive Work Sessions without transferring progress into a session aggregate.

**Blocked by:** None. BWG Core Tickets 10, 11, and 15 are resolved.

**Status:** resolved

- [x] Several live Work Sessions can be registered for one eligible Work Challenge with distinct
  session credentials, targets, and event identities.
- [x] Accepted Work Events from concurrent and successive sessions accumulate in the existing exact
  challenge-scoped Credited Work ledger across restart.
- [x] Event replay, event-identity conflict, and share-fingerprint reuse across any two sessions
  cannot add progress twice.
- [x] Expiring, failing, or disconnecting one session cannot subtract, transfer, or recalculate
  already accepted progress.
- [x] Concurrent threshold-crossing delivery creates one stable issuance intent and never
  overflows or issues twice.

## Answer

The existing PostgreSQL Authority transaction already had the required multi-session semantics:
each event resolves its Work Session to one challenge, locks that challenge's exact progress row,
deduplicates the Authority-wide share fingerprint, advances the challenge projection, and inserts
at most one issuance intent before committing its stable acknowledgement. No parallel aggregate or
production rewrite was needed.

A dedicated PostgreSQL acceptance suite now proves two concurrent leases receive distinct opaque
Stratum usernames and secrets from the real credential issuer, authenticate through the durable Pool
Adapter registry, contribute distinct assigned targets and event identities, cross one threshold
once, and recover one issuance after restart. Separate tracers prove a failed first session cannot
erase progress before a successive post-restart session contributes, and conflicting reuse of one
event identity by another session cannot mutate progress. Existing persistence and lifecycle tests
provide the complementary exact-replay, cross-session share-fingerprint, lease-expiry, interruption,
and pause evidence.
