# 04: Require trusted reconfirmation for material Pool Offer changes

**What to build:** Ticket 20's real replacement-offer path derives trusted confirmation from
prior/current authenticated terms instead of a caller-supplied boolean.

**Blocked by:** 03: Harden the trusted browser flow and prove the real receipt seam; BWG Core 20:
Aggregate Workers and fail over equivalent Pool Offers.

**Status:** ready-for-agent

- [ ] Production replacement classifies reward, fee, payout, beneficiary, and privacy changes using
  the existing domain classifier.
- [ ] Equivalent endpoint-only failover does not require fresh consent.
- [ ] Every material change signs `trusted_confirmation_required` before release.
- [ ] Old consent/receipts cannot authorize work under changed terms.
- [ ] Parent Ticket 14 and the material-change acceptance item in Ticket 20 share one composed proof.
