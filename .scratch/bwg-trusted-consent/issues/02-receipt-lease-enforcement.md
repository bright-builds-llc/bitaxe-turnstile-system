# 02: Sign trusted receipts and enforce them at lease start

**What to build:** Only a verified Trusted Origin Confirmation can mint a short-lived signed receipt,
and every consequential Work Session lease requires that exact receipt.

**Blocked by:** 01: Verify an attested WebAuthn ceremony on the Authority.

**Status:** ready-for-agent

- [ ] Receipt claims bind issuer, challenge, disclosure digest, Pool Offer digest, reason, origin,
  WebAuthn assurances, issue/expiry time, and `BWG/0.1`.
- [ ] Receipt lookup/retry returns identical signed bytes without repeating WebAuthn verification.
- [ ] Lease start requires and verifies the receipt whenever authenticated challenge terms require
  trusted confirmation.
- [ ] Missing, forged, stale, wrong-origin, wrong-challenge, wrong-disclosure, or replayed receipts
  cannot start or renew work.
- [ ] Light/Standard leases without a signed requirement remain backward compatible.
- [ ] Receipt enforcement survives Authority/Pool Adapter restart and concurrent lease attempts.
