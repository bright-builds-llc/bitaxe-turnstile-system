# 10: Pause, cancel, expire, and resume safely

**What to build:** Claimants and Workers receive deterministic outcomes for every interruption and terminal state. Pause preserves accepted progress, Cancel is terminal, stale artifacts fail closed, and loss of continuity cannot leave challenge mining unbounded.

**Blocked by:** 09: Prove persistent lifecycle recovery and data governance.

**Status:** ready-for-agent

- [ ] Every allowed and forbidden Work Challenge transition has observable behavior.
- [ ] Every allowed and forbidden Work Session transition has observable behavior.
- [ ] Pause ends leases and retains Verified Progress until challenge expiry.
- [ ] Tab closure and connectivity loss behave like Pause.
- [ ] Explicit Cancel explains and enforces terminal loss of authorization eligibility.
- [ ] Challenge, Work Lease, DPoP, and Gate Pass deadlines use the agreed defaults and bounded clock skew.
- [ ] Reboot, monotonic reset, or uncertain Worker time terminates rather than resumes a Work Lease.
- [ ] Accepted work arriving after challenge expiry cannot authorize the action.
