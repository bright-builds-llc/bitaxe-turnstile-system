# 02: Sign trusted receipts and enforce them at lease start

**What to build:** Only a verified Trusted Origin Confirmation can mint a short-lived signed receipt,
and every consequential Work Session lease requires that exact receipt.

**Blocked by:** 01: Verify an attested WebAuthn ceremony on the Authority.

**Status:** resolved

- [x] Receipt claims bind issuer, challenge, disclosure digest, Pool Offer digest, reason, origin,
  WebAuthn assurances, issue/expiry time, and `BWG/0.1`.
- [x] Receipt lookup/retry returns identical signed bytes without repeating WebAuthn verification.
- [x] Lease start requires and verifies the receipt whenever authenticated challenge terms require
  trusted confirmation.
- [x] Missing, forged, stale, wrong-origin, wrong-challenge, wrong-disclosure, or replayed receipts
  cannot start or renew work.
- [x] Light/Standard leases without a signed requirement remain backward compatible.
- [x] Receipt enforcement survives Authority/Pool Adapter restart and concurrent lease attempts.

## Answer

A terminal verified ceremony now yields one deterministic Ed25519
`bwg-trusted-consent+jws` receipt whose claims pin every Ticket 02 field and whose exact bytes are
durably recoverable across response loss, restart, or signing-key availability changes. The Pool
Adapter verifies that receipt against Authority-derived challenge terms, then the PostgreSQL lease
transaction binds it to at most one Work Session only after every lifecycle decision succeeds.
Concurrent sessions converge on one admission; failed attempts roll back; renewal uses the retained
admission after restart. Additive migration `0010` upgrades representative Ticket 01 data, and the
governance plan/apply path exclusively clears expired compact bytes without permitting remint.
Independent Standards and Spec reviews against `ed620ef` pass.
The required Rust format, Clippy, all-target build, full Rust suite, browser suite, package check, and
Bright Builds standards verifier also pass.
