# 12: Obtain Work Consent through the headless client

**What to build:** A framework-independent browser client lets the Claimant understand, approve, observe, Pause, and Cancel bounded work without exposing private keys or trusting estimates as completion evidence.

**Blocked by:** 10: Pause, cancel, expire, and resume safely; 11: Disclose and select a solo Pool Offer.

**Status:** ready-for-agent

- [ ] The client generates and retains a fresh non-extractable pairwise Claimant key only through artifact expiry.
- [ ] Exact expected hashes, Equivalent Binary-Zero Work, duration, available energy estimate, Reward Policy, Pool Offer, Payout Destination, and participating Workers are presented before Start.
- [ ] Work cannot start on page load or exceed the Claimant's configured ceiling.
- [ ] Verified Progress and Activity Estimate remain distinct throughout the lifecycle.
- [ ] Start, Pause, resume, and terminal Cancel map to the agreed public lifecycle.
- [ ] Typed lifecycle events expose no private key, credential, action payload, or unrelated identifier.
- [ ] Headless behavior is covered through browser-visible interfaces and independent protocol fixtures.
