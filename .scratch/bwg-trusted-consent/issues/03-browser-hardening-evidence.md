# 03: Harden the trusted browser flow and prove the real receipt seam

**What to build:** The conforming component drives the production Authority ceremony and cannot
record consent or start work after cancellation, teardown, popup failure, or receipt rejection.

**Blocked by:** 02: Sign trusted receipts and enforce them at lease start.

**Status:** ready-for-agent

- [ ] The trusted surface independently loads and verifies challenge and signed Pool Offer terms.
- [ ] Popup transport is exact-origin, exact-source, state-bound, abortable, and time-bounded.
- [ ] Component teardown closes the popup, removes listeners/timers, and prevents late Start.
- [ ] Strict JWS profile, trust-key, signature, claim, time, origin, UP/UV, and attestation negative
  vectors each have focused coverage.
- [ ] Real Chromium drives the production begin/finish routes, verifies a real signed receipt, and
  proves that receipt gates lease start.
- [ ] Physical authenticator compatibility and attestation-root rollout risks are documented.
