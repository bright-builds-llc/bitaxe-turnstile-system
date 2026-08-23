# BWG Core MVP Success Criteria

BWG Core is successful when one reproducible mainnet-capable flow proves all of the following:

1. A reference Relying Service backend creates a challenge from a version-pinned account-creation Action Policy.
2. A Claimant selects either a Bitaxe Reference Client or another standard Stratum V1 Worker.
3. Bitaxe onboarding preserves admitted settings and requires no Account Identity or mobile application.
4. Work Consent discloses exact expected hashes, 44-bit Equivalent Binary-Zero Work, Reward Policy, Payout Destination, participating Workers, and estimated duration.
5. The pool path independently verifies reward outputs and obtains BIP 23 proposal acceptance for the exact constructed mainnet job before release.
6. Mainnet work passes through the Rust Pool Adapter proxy to pinned Hydra without teaching the pool Protected Action concepts.
7. Accepted Work Events advance exact Verified Progress without loss or duplicate credit under replay.
8. Reaching the Work Requirement ends every Work Lease and confirms Mining Baseline restoration.
9. A two-minute JWS Gate Pass redeems with fresh DPoP for the exact Action Reference.
10. The reference action executes idempotently, creates a Redemption Record, and cannot reuse or refresh the pass.
11. Expiry, Pause, terminal Cancel, disconnect, adapter replay, pool failure, malformed payout, invalid proposal, and stale-job cases fail safely.
12. Versioned Client, Gate Authority, Pool Adapter, and Relying Service Conformance Profiles pass reproducibly in CI.
13. Privacy tests prove forbidden Account Identity, Device Identity, payout, network, credential, and action-payload data do not cross their context boundaries.
