# 04: Retire Relying Service records safely

**What to build:** A Relying Service operator can retire protocol records after replay, Gate Pass acceptance, public lookup, and terminal execution floors without reopening Redemption or altering immutable Protected Action Outcomes.

**Blocked by:** 02: Plan retention through service-local operator CLIs.

**Status:** ready-for-agent

- [ ] DPoP and Outcome proof identities are deleted immediately after their replay floors, and Pass Consumption survives until no conforming verifier can accept the pass.
- [ ] Additive terminal-time fields and safe backfill make legacy Relying Service operational rows ineligible before a proven terminal instant and eligible afterward.
- [ ] Eligible Redemption Records, outcomes, attempts, intents, and operational identifiers are pseudonymized at day 30 and their tombstones deleted at day 90.
- [ ] Account Identity and application business records remain outside the governance transition.
- [ ] Bounded context-local batches resume idempotently after crashes without changing terminal outcome state.
- [ ] Public Redemption and Outcome Lookup evidence proves the configured lookup window remains independent of internal retirement.
