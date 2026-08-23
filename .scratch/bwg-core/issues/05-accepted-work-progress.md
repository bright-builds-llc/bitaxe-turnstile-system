# 05: Credit accepted work and stream Verified Progress

**What to build:** A simulated Pool Adapter can report accepted target-qualified work and a Claimant can observe exact Verified Progress through the public lifecycle stream. Retries remain safe and no estimate or Worker report can advance authorization.

**Blocked by:** 01: Issue the first browser-safe Work Challenge; 02: Standardize exact work encoding and vectors.

**Status:** resolved

- [x] Accepted Work Events carry stable event identity, Work Session identity, assigned target, receipt time, share fingerprint, and network-target outcome.
- [x] Credited Work is computed from the assigned target effective for the submitted result.
- [x] Duplicate event identities and duplicate share fingerprints do not advance progress twice.
- [x] Replayed delivery produces the same observable state and acknowledgement.
- [x] Verified Progress streams through SSE using exact work values.
- [x] Activity Estimate is visibly and semantically separate from Verified Progress.
- [x] Worker-reported hashes, hashrate, and lucky hash depth never count toward completion.

## Answer

Added the Accepted Work Event and projection core with parsed stable event, Work Session, share-fingerprint, receipt-time, assigned-target, and network-target fields. Challenge-scoped sessions must be registered before reporting. The first event/share pair computes Credited Work only from its assigned 256-bit target; Worker hashes, hashrate, lucky depth, and network-target outcome never change the credit amount.

The in-memory tracer ledger stores Authority-wide canonical event identities, share fingerprints, and stable acknowledgements. Exact event replay returns the same acknowledgement and projection; conflicting reuse of an event identity fails closed, even across challenges. A new event identity for an existing share in any challenge returns a stable `duplicate_share` acknowledgement with no credit. The same domain port is ready for the PostgreSQL transaction and gRPC adapter added by later persistence and Pool Adapter tickets.

Every issued challenge now registers an exact zero-progress projection. `GET /v0/challenges/{challenge_id}/events` sends an immediate SSE snapshot and subsequent actual progress changes using decimal Verified Progress and Work Requirement values. `activity_estimate` is a separate object and currently reports `unavailable`; lag is surfaced as `resync_required`. `bun run verify` passes.
