# 11: Disclose and select a solo Pool Offer

**What to build:** A Claimant can select an approved solo/direct-payout Pool Offer whose Reward Policy, fees, Payout Destinations, privacy terms, source, and license are immutable and visible before Work Consent.

**Blocked by:** 04: Secure challenge issuance and publish Authority discovery; 08: Complete and redeem a proof-of-possession Gate Pass.

**Status:** resolved

- [x] The challenge carries a signed set of approved Pool Offers without allowing browser substitution.
- [x] Every offer discloses pool and adapter identity, transport, endpoint, rewards, fees, payout requirements, source, license, and terms.
- [x] A per-challenge Payout Destination or explicit beneficiary is selected before work begins.
- [x] Payout data never appears in the Gate Pass or reaches the Relying Service.
- [x] V1 accepted work creates gate progress but no future-revenue claim or custodial balance.
- [x] Equivalent and materially changed offer terms are classified deterministically.
- [x] Reward Policy and payout commitments cannot change after Work Consent.

## Answer

Work Challenges now carry a challenge-, issuer-, and Action-Policy-bound compact JWS over the exact
approved Pool Offer set. The reference offer discloses the P2Poolv2/Hydra engine and BWG adapter
identities, versions, sources, separate AGPL/MIT licenses, Stratum endpoint, zero-fee
solo/direct-coinbase Reward Policy, payout requirements, privacy, and operator terms. The Pool
Adapter validates checksum-correct mainnet destinations, keeps raw payout data local, and persists
only a challenge-scoped SHA-256 commitment. Selection may change before confirmation, becomes
immutable after consent, survives restart, and gates every Work Session. Pure classification,
signature-tamper, cross-challenge replay, migration, governance, Gate Pass, and Relying Service
tests cover the economic/privacy boundaries. Standards and Spec reviews against `764556a` both
passed with no remaining findings.
