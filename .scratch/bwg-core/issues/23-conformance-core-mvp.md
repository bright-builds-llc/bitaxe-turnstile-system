# 23: Publish BWG/0.x Conformance Profiles and prove the Core MVP

**What to build:** Versioned executable Client, Gate Authority, Pool Adapter, and Relying Service Conformance Profiles plus one reproducible end-to-end evidence set demonstrate every BWG Core MVP success criterion.

**Blocked by:** 12: Require trusted-origin consent for Elevated work; 17: Submit block candidates independently of gate outages; 18: Aggregate Workers and fail over equivalent Pool Offers; 21: Prove Work Lease restoration on real Bitaxe hardware; 22: Package a reproducible self-hosted reference deployment.

**Status:** ready-for-agent

- [ ] Each role profile names its exact BWG/0.x version and publishes one reproducible command.
- [ ] Positive and negative fixtures cover work arithmetic, lifecycle, signatures, DPoP, event replay, expiry, rewards, privacy, and failure behavior.
- [ ] Implementations can self-certify only the profiles they actually pass.
- [ ] The reference account-creation journey passes through the hosted and self-hosted public seams.
- [ ] Standard Stratum and real Bitaxe paths both satisfy the same Gate Authority accounting and Redemption semantics.
- [ ] Every Core MVP success criterion has linked executable or hardware evidence.
- [ ] Mainnet evidence includes exact job admission and independent block-submission behavior.
- [ ] Residual risks and non-claims are published without weakening the protocol's stated guarantees.
