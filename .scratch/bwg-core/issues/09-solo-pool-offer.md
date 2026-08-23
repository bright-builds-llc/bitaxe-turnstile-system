# 09: Disclose and select a solo Pool Offer

**What to build:** A Claimant can select an approved solo/direct-payout Pool Offer whose Reward Policy, fees, Payout Destinations, privacy terms, source, and license are immutable and visible before Work Consent.

**Blocked by:** 04: Secure challenge issuance and publish Authority discovery; 06: Complete and redeem a proof-of-possession Gate Pass.

**Status:** ready-for-agent

- [ ] The challenge carries a signed set of approved Pool Offers without allowing browser substitution.
- [ ] Every offer discloses pool and adapter identity, transport, endpoint, rewards, fees, payout requirements, source, license, and terms.
- [ ] A per-challenge Payout Destination or explicit beneficiary is selected before work begins.
- [ ] Payout data never appears in the Gate Pass or reaches the Relying Service.
- [ ] V1 accepted work creates gate progress but no future-revenue claim or custodial balance.
- [ ] Equivalent and materially changed offer terms are classified deterministically.
- [ ] Reward Policy and payout commitments cannot change after Work Consent.
