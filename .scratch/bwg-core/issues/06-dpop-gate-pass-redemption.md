# 06: Complete and redeem a proof-of-possession Gate Pass

**What to build:** Accepted work can satisfy a Work Challenge, produce a short-lived Gate Pass, and authorize one idempotent reference account-creation action only when the Claimant proves possession of the bound key.

**Blocked by:** 03: Prove Gate Pass cryptographic interoperability; 04: Secure challenge issuance and publish Authority discovery; 05: Credit accepted work and stream Verified Progress.

**Status:** ready-for-agent

- [ ] Threshold crossing creates durable Gate Pass issuance intent exactly once.
- [ ] The signed pass binds issuer, audience, challenge, Action Reference, Claimant key, issue time, expiry, and unique pass identity.
- [ ] Redemption verifies the configured Authority, exact audience and action, unexpired pass, and fresh DPoP proof.
- [ ] The first valid Redemption atomically consumes the pass and creates one Redemption Record.
- [ ] Concurrent, copied, wrong-key, wrong-action, wrong-audience, expired, and replayed requests fail safely.
- [ ] Response loss returns the same accepted action outcome without reauthorizing the pass.
- [ ] The acceptance harness proves the complete simulated issue-work-pass-redeem journey through public interfaces.
