# 03: Fail over only between materially equivalent Pool Offers

**What to build:** The production replacement-offer path loads authenticated prior/current terms,
automatically releases only equivalent candidates, and exposes a fail-closed pending seam for
material reconfirmation.

**Blocked by:** 02: Replace failed Workers without durable device identity.

**Status:** resolved

- [x] Replacement loads the durably consented Pool Offer and an Authority-signed candidate; callers
  cannot supply an authoritative equivalence or trusted-confirmation boolean.
- [x] The existing domain classifier determines the result from reward, fee, payout, beneficiary,
  privacy, and operator terms before any new lease or work release.
- [x] Endpoint-only change with otherwise identical terms is persisted as equivalent and may fail
  over automatically without fresh consent.
- [x] Every material candidate is persisted as pending reconfirmation, exposes exact authenticated
  prior/current bindings, and releases no work.
- [x] Concurrent replacement, response loss, Pool Adapter restart, stale generations, and candidate
  reordering converge on one stable current or pending offer.
- [x] The pending transition is the production integration seam consumed by
  [`bwg-trusted-consent` Ticket 04](../../bwg-trusted-consent/issues/04-material-change-bridge.md).

## Answer

The Pool Adapter now accepts only a compact Authority-signed candidate set. It reloads the stopped
predecessor's retained Pool Selection and immutable challenge offer set, verifies both signatures
against the configured issuer, challenge, Action Policy, and trusted keys, selects the retained
offer identity, and invokes the existing pure material-change classifier. No caller boolean can
authorize equivalence or trusted confirmation.

The exact prior offer, candidate offer, candidate signature, classification, proposed replacement
session, and decision time are persisted immutably before work release. Endpoint-only change
persists as `equivalent` and recovers one generation-fenced replacement Work Session; exact retries
before or after Authority/Pool Adapter restart return the same decision. Material economic or
privacy candidates persist as `pending_reconfirmation`, create no Work Session, and cannot start a
lease. Concurrent differently ordered candidates converge on the first committed decision while
the loser fails closed, leaving one stable seam for Trusted Consent Ticket 04.
