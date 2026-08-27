# 04: Require trusted reconfirmation for material Pool Offer changes

**What to build:** The real replacement-offer seam derives trusted confirmation from prior/current
authenticated terms instead of a caller-supplied boolean.

**Blocked by:** 03: Harden the trusted browser flow and prove the real receipt seam;
[`bwg-multi-worker-failover` Ticket 03](../../bwg-multi-worker-failover/issues/03-equivalent-offer-failover.md).

**Status:** resolved

- [x] Production replacement classifies reward, fee, payout, beneficiary, and privacy changes using
  the existing domain classifier.
- [x] Equivalent endpoint-only failover does not require fresh consent.
- [x] Every material change signs `trusted_confirmation_required` before release.
- [x] Old consent/receipts cannot authorize work under changed terms.
- [x] The resulting evidence is consumed by `bwg-multi-worker-failover` Ticket 04 so parent Tickets
  14 and 20 share one composed proof without a circular dependency.

## Answer

Each pending material decision now derives a durable Authority-signed candidate set with
`trusted_confirmation_required` and a replacement-specific digest claim over the predecessor,
proposed session, prior/candidate terms, and classified changes. The trusted surface reloads that
signed candidate and disclosure by signature digest, independently verifies it, and uses the
existing Authority WebAuthn ceremony to issue a receipt bound to the exact material terms.

The candidate Work Session does not exist before confirmation. Lease release verifies the fresh
receipt against the persisted material binding, atomically creates the generation-fenced
replacement with a session-local trusted-confirmation requirement, and consumes the ceremony at
lease admission. A receipt for different material terms and malformed or stale receipts fail before
session creation. Endpoint-only equivalent decisions retain their Ticket 03 path and require no
ceremony. Signed confirmation preparation is byte-stable and recoverable after restart even when
the signing key is unavailable.
