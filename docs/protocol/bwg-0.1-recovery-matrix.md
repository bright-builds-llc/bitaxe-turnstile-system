# BWG/0.1 Persistent Recovery Matrix

This matrix composes the PostgreSQL-backed public-interface evidence for the Gate Authority and Reference Relying Service. Database rows are never used as acceptance-test oracles.

| Failure boundary | Durable invariant | Public recovery evidence |
| --- | --- | --- |
| After Work Challenge issuance | Immutable policy and zero progress remain observable | `issued_challenge_remains_observable_after_authority_restart` reconnects to progress SSE after process replacement. |
| After Accepted Work commit | Event identity, share fingerprint, acknowledgement, and progress remain canonical | `accepted_threshold_event_replays_identically_after_authority_restart` resends the same adapter event after replacement and receives the identical acknowledgement. |
| Concurrent or repeated share delivery | One share contributes Credited Work at most once | `concurrent_duplicate_share_is_credited_only_once` and the accepted-work replay tests exercise distinct and repeated event identities. |
| After threshold crossing | One issuance intent and outbox entry survive | The threshold replay test preserves `issuance_intent_created` and exact satisfied progress across restart. |
| During Gate Pass signing | A live lease blocks takeover; an expired lease is reclaimable | `expired_signing_lease_recovers_one_exact_pass_across_restart` replaces the process and recovers one pass. |
| After pass storage or response loss | Lookup returns the exact stored JWS and never signs again | The issuance lookup test drops an unread response, proves proof consumption, and retrieves identical bytes with fresh proofs. |
| At issuance deadline | Unsigned intent becomes terminally failed | `challenge_expiry_permanently_fails_unsigned_issuance` observes durable `failed`. |
| After Redemption acceptance or response loss | Pass remains consumed; action identity converges on one record | The persistent Redemption test drops an unread POST response, replaces the process, rejects the consumed pass, and converges a second valid pass on the pending record. |
| Concurrent Redemptions | Every valid pass is consumed while one action record and execution intent exist | `concurrent_valid_passes_converge_and_are_both_consumed` drives two public Redemptions concurrently. |
| During Protected Action execution | A live lease blocks takeover; expiry creates a new bounded attempt | `expired_action_lease_recovers_one_immutable_success` recovers account creation after process replacement. |
| At attempt/deadline exhaustion | Pending outcome becomes immutable failed and attempts are terminal | The exhaustion and non-retryable executor tests observe safe terminal failure and no later execution. |
| After action completion or lookup response loss | Terminal outcome and safe result remain stable | The Outcome Lookup test drops an unread response, rejects replay, returns identical results with a fresh proof, and confirms workers cannot re-execute. |

## Retention invariants already enforced

- Issuance and Outcome proof identities are unique and deleted after their freshness windows by the durable workers and lookup transactions.
- Claimant-facing Outcome Lookup uses a configurable window defaulting to 24 hours.
- Unsigned issuance cannot survive its Work Challenge deadline, and signed pass acceptance remains bounded by its signed expiry.
- Gate Authority and Relying Service migrations, schemas, transactions, and replay indexes remain context-local even in one PostgreSQL database.

Longer audit/product retention, operator-authorized export, and destructive or pseudonymizing deletion require a separate governance contract. They cannot be inferred from claimant-facing protocol authorization.
