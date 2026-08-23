# 20: Aggregate Workers and fail over equivalent Pool Offers

**What to build:** Several Workers and successive Work Sessions can contribute to one Work Challenge, and an unavailable session or pool can be replaced without losing Verified Progress or silently changing consented terms.

**Blocked by:** 10: Pause, cancel, expire, and resume safely; 11: Disclose and select a solo Pool Offer; 15: Accept standard Stratum V1 work through the transparent proxy.

**Status:** ready-for-agent

- [ ] One challenge aggregates exact Credited Work across concurrent and successive Work Sessions.
- [ ] Worker failure or disconnect ends only the affected lease and preserves accepted progress.
- [ ] Replacement Workers can resume the active challenge without sharing persistent device identity.
- [ ] Automatic failover occurs only between pre-consented materially equivalent Pool Offers.
- [ ] Reward, fee, payout, or privacy changes require fresh Work Consent before new work starts.
- [ ] Per-session progress and failover state remain visible without leaking Worker identity to the Relying Service.
- [ ] Threshold crossing under concurrent delivery issues one Gate Pass and stops every lease.
