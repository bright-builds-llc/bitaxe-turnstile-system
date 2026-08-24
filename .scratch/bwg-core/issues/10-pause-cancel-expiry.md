# 10: Pause, cancel, expire, and resume safely

**What to build:** Claimants and Workers receive deterministic outcomes for every interruption and terminal state. Pause preserves accepted progress, Cancel is terminal, stale artifacts fail closed, and loss of continuity cannot leave challenge mining unbounded.

**Blocked by:** 09: Prove persistent lifecycle recovery and data governance.

**Status:** resolved

- [x] Every allowed and forbidden Work Challenge transition has observable behavior.
- [x] Every allowed and forbidden Work Session transition has observable behavior.
- [x] Pause ends leases and retains Verified Progress until challenge expiry.
- [x] Tab closure and connectivity loss behave like Pause.
- [x] Explicit Cancel explains and enforces terminal loss of authorization eligibility.
- [x] Challenge, Work Lease, DPoP, and Gate Pass deadlines use the agreed defaults and bounded clock skew.
- [x] Reboot, monotonic reset, or uncertain Worker time terminates rather than resumes a Work Lease.
- [x] Accepted work arriving after challenge expiry cannot authorize the action.

## Answer

Gate Authority lifecycle and Work Session state are now PostgreSQL-authoritative and governed by a
shared pure transition core. The service-authenticated Pause/Cancel commands, redacted lifecycle
snapshot, typed progress/lifecycle SSE stream, and simulated Pool Adapter expose deterministic
outcomes. Every new Accepted Work Event must present the active lease identity and a continuous
Worker monotonic reading; exact replays remain stable after leases stop. Additive migration 0007
fails legacy session continuity closed, and integration tests cover concurrent control/report and
Cancel/registration races, restart/resume, exact expiry, clock loss, authorization eligibility,
deadline defaults, OpenAPI, and prohibited future DPoP proofs. Standards and Spec reviews against
`d95c49e6ed5574317074fd978b220cc71978494a` both passed with no remaining findings.
