# 04: Retire Relying Service records safely

**What to build:** A Relying Service operator can retire protocol records after replay, Gate Pass acceptance, public lookup, and terminal execution floors without reopening Redemption or altering immutable Protected Action Outcomes.

**Blocked by:** 02: Plan retention through service-local operator CLIs.

**Status:** resolved

- [x] DPoP and Outcome proof identities are deleted immediately after their replay floors, and Pass Consumption survives until no conforming verifier can accept the pass.
- [x] Additive terminal-time fields and safe backfill make legacy Relying Service operational rows ineligible before a proven terminal instant and eligible afterward.
- [x] Eligible Redemption Records, outcomes, attempts, intents, and operational identifiers are pseudonymized at day 30 and their tombstones deleted at day 90.
- [x] Account Identity and application business records remain outside the governance transition.
- [x] Bounded context-local batches resume idempotently after crashes without changing terminal outcome state.
- [x] Public Redemption and Outcome Lookup evidence proves the configured lookup window remains independent of internal retirement.

## Answer

Added authoritative Gate Pass expiry to new Pass Consumption rows and terminal-time projection to
immutable Protected Action Outcomes. The planner keeps legacy rows with missing safety evidence
ineligible, respects longer public lookup and pass-marker floors, coalesces aggregate-owned markers,
and supports separate marker retirement when an aggregate remains public. Day-30 aggregate cleanup
creates one outcome tombstone plus marker-specific HMAC tombstones before atomically deleting BWG
Redemption, outcome, attempt, intent, consumption, and Protected Action rows. Account business rows
remain intact. Day-90 and overdue-first-run paths delete the remaining protocol evidence, while
public tests prove a terminal success remains immutable and lookup survives marker cleanup until its
configured window ends.
Standalone markers whose aggregates remain public past marker day 90 now plan a typed overdue direct
deletion, avoiding an already-expired tombstone while leaving the public outcome untouched.
