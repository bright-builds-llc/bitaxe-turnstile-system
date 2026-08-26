# 04: Require trusted reconfirmation for material Pool Offer changes

**What to build:** The real replacement-offer seam derives trusted confirmation from prior/current
authenticated terms instead of a caller-supplied boolean.

**Blocked by:** 03: Harden the trusted browser flow and prove the real receipt seam;
[`bwg-multi-worker-failover` Ticket 03](../../bwg-multi-worker-failover/issues/03-equivalent-offer-failover.md).

**Status:** ready-for-agent

- [ ] Production replacement classifies reward, fee, payout, beneficiary, and privacy changes using
  the existing domain classifier.
- [ ] Equivalent endpoint-only failover does not require fresh consent.
- [ ] Every material change signs `trusted_confirmation_required` before release.
- [ ] Old consent/receipts cannot authorize work under changed terms.
- [ ] The resulting evidence is consumed by `bwg-multi-worker-failover` Ticket 04 so parent Tickets
  14 and 20 share one composed proof without a circular dependency.
