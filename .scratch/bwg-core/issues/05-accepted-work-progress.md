# 05: Credit accepted work and stream Verified Progress

**What to build:** A simulated Pool Adapter can report accepted target-qualified work and a Claimant can observe exact Verified Progress through the public lifecycle stream. Retries remain safe and no estimate or Worker report can advance authorization.

**Blocked by:** 01: Issue the first browser-safe Work Challenge; 02: Standardize exact work encoding and vectors.

**Status:** ready-for-agent

- [ ] Accepted Work Events carry stable event identity, Work Session identity, assigned target, receipt time, share fingerprint, and network-target outcome.
- [ ] Credited Work is computed from the assigned target effective for the submitted result.
- [ ] Duplicate event identities and duplicate share fingerprints do not advance progress twice.
- [ ] Replayed delivery produces the same observable state and acknowledgement.
- [ ] Verified Progress streams through SSE using exact work values.
- [ ] Activity Estimate is visibly and semantically separate from Verified Progress.
- [ ] Worker-reported hashes, hashrate, and lucky hash depth never count toward completion.
