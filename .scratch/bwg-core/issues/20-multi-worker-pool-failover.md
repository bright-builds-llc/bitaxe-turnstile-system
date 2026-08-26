# 20: Aggregate Workers and fail over equivalent Pool Offers

**What to build:** Several Workers and successive Work Sessions can contribute to one Work Challenge, and an unavailable session or pool can be replaced without losing Verified Progress or silently changing consented terms.

**Blocked by:** Child effort `bwg-multi-worker-failover`; `bwg-trusted-consent` Ticket 04 for the
material-change bridge. Original prerequisite Tickets 10, 11, and 15 are resolved.

**Status:** claimed

**Child effort:** [`bwg-multi-worker-failover`](../../bwg-multi-worker-failover/map.md)

- [ ] One challenge aggregates exact Credited Work across concurrent and successive Work Sessions.
- [ ] Worker failure or disconnect ends only the affected lease and preserves accepted progress.
- [ ] Replacement Workers can resume the active challenge without sharing persistent device identity.
- [ ] Automatic failover occurs only between pre-consented materially equivalent Pool Offers.
- [ ] Reward, fee, payout, or privacy changes require fresh Work Consent before new work starts.
- [ ] Per-session progress and failover state remain visible without leaking Worker identity to the Relying Service.
- [ ] Threshold crossing under concurrent delivery issues one Gate Pass and stops every lease.

## Delivery ownership

- `bwg-multi-worker-failover` Ticket 01 owns exact concurrent/successive aggregation and the
  single-issuance threshold race.
- Tickets 02 and 03 own failure isolation, unlinkable replacement, safe visibility, and the
  production equivalent-offer failover seam.
- [`bwg-trusted-consent` Ticket 04](../../bwg-trusted-consent/issues/04-material-change-bridge.md)
  owns the signed material-change reconfirmation bridge after that seam exists.
- `bwg-multi-worker-failover` Ticket 04 owns composed recovery, terminal lease shutdown, shared
  evidence, and parent-ticket closure.
