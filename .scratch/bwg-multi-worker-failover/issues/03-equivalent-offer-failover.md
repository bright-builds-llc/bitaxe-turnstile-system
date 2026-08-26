# 03: Fail over only between materially equivalent Pool Offers

**What to build:** The production replacement-offer path loads authenticated prior/current terms,
automatically releases only equivalent candidates, and exposes a fail-closed pending seam for
material reconfirmation.

**Blocked by:** 02: Replace failed Workers without durable device identity.

**Status:** ready-for-agent

- [ ] Replacement loads the durably consented Pool Offer and an Authority-signed candidate; callers
  cannot supply an authoritative equivalence or trusted-confirmation boolean.
- [ ] The existing domain classifier determines the result from reward, fee, payout, beneficiary,
  privacy, and operator terms before any new lease or work release.
- [ ] Endpoint-only change with otherwise identical terms is persisted as equivalent and may fail
  over automatically without fresh consent.
- [ ] Every material candidate is persisted as pending reconfirmation, exposes exact authenticated
  prior/current bindings, and releases no work.
- [ ] Concurrent replacement, response loss, Pool Adapter restart, stale generations, and candidate
  reordering converge on one stable current or pending offer.
- [ ] The pending transition is the production integration seam consumed by
  [`bwg-trusted-consent` Ticket 04](../../bwg-trusted-consent/issues/04-material-change-bridge.md).
