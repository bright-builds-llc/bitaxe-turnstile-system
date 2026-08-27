# 20: Aggregate Workers and fail over equivalent Pool Offers

**What to build:** Several Workers and successive Work Sessions can contribute to one Work Challenge, and an unavailable session or pool can be replaced without losing Verified Progress or silently changing consented terms.

**Blocked by:** Child effort `bwg-multi-worker-failover`; `bwg-trusted-consent` Ticket 04 for the
material-change bridge. Original prerequisite Tickets 10, 11, and 15 are resolved.

**Status:** resolved

**Child effort:** [`bwg-multi-worker-failover`](../../bwg-multi-worker-failover/map.md)

- [x] One challenge aggregates exact Credited Work across concurrent and successive Work Sessions.
- [x] Worker failure or disconnect ends only the affected lease and preserves accepted progress.
- [x] Replacement Workers can resume the active challenge without sharing persistent device identity.
- [x] Automatic failover occurs only between pre-consented materially equivalent Pool Offers.
- [x] Reward, fee, payout, or privacy changes require fresh Work Consent before new work starts.
- [x] Challenge-level exact progress and per-session failover state remain visible without leaking
  Worker identity to the Relying Service.
- [x] Threshold crossing under concurrent delivery issues one Gate Pass and stops every lease.

## Delivery ownership

- `bwg-multi-worker-failover` Ticket 01 owns exact concurrent/successive aggregation and the
  single-issuance threshold race.
- Tickets 02 and 03 own failure isolation, unlinkable replacement, safe visibility, and the
  production equivalent-offer failover seam.
- [`bwg-trusted-consent` Ticket 04](../../bwg-trusted-consent/issues/04-material-change-bridge.md)
  owns the signed material-change reconfirmation bridge after that seam exists.
- `bwg-multi-worker-failover` Ticket 04 owns composed recovery, terminal lease shutdown, shared
  evidence, and parent-ticket closure.

## Answer

The [`bwg-multi-worker-failover`](../../bwg-multi-worker-failover/map.md) child effort now supplies
challenge-scoped exact aggregation, session-local failure, generation-fenced unlinkable
replacement, authenticated equivalent-offer failover, material pending/reconfirmation, and a safe
Pool Adapter projection of per-session recovery state and current/pending terms. Pending material
session identities are transactionally reserved, so neither generic replacement nor direct
registration can release unconfirmed work.

The composed PostgreSQL acceptance journey pauses and resumes the database, restarts the Authority
and Pool Adapter around a pending decision, accepts new work through the equivalent replacement,
recovers the exact earlier challenge progress, rejects an old/different-terms receipt, admits the
exact confirmed material candidate, and proves the later concurrent events cannot satisfy the
threshold without that retained progress. Completion terminally stops every leased or ready session
and recovers one issuance outcome exactly once. Its Relying-facing lifecycle remains aggregate and
identity-free; the Pool Adapter projection exposes per-session state, not a second session-owned
progress aggregate.
