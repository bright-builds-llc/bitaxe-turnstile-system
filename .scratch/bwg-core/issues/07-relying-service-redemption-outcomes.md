# 07: Persist Redemption and Protected Action outcomes

**What to build:** PostgreSQL becomes authoritative for Relying Service Pass Consumption, Action Reference idempotency, Redemption Records, execution scheduling, and claimant-authenticated durable outcome retrieval.

**Blocked by:** 06: Persist Authority accounting and recover Gate Pass issuance.

**Status:** resolved

- [x] The Relying Service owns a separate PostgreSQL schema, forward-only migrations, repository ports, and durable Trusted Authority Key Set without cross-context database access.
- [x] Action References pin one Claimant-key thumbprint, Protected Action Type, and immutable Action Policy revision before challenge issuance.
- [x] One transaction consumes `(issuer, pass_id)`, converges on one `(audience, Action Reference)` Redemption Record, creates one pending Protected Action Outcome, and inserts one Action Execution Intent.
- [x] Later valid same-Claimant passes for the action are consumed and linked to the existing record without restarting execution; a conflicting Claimant key is rejected without consumption or disclosure.
- [x] Action workers recover with durable leases and apply the policy-pinned deadline, attempt bound, retryable-error classes, and downstream Action Reference idempotency.
- [x] Claimant-authenticated Outcome Lookup returns only safe `pending`, `succeeded`, or `failed` representations during its configurable public window and cannot authorize or restart an action.
- [x] PostgreSQL-backed tests through public interfaces prove concurrent consumption, response loss, process restart, execution-worker lease recovery, immutable terminal outcomes, and indistinguishable unauthorized or unavailable lookups.

## Answer

Implemented an isolated `relying_service` PostgreSQL schema, schema-local SQLx migration history, repository port, and durable configured Authority key set. Reference challenge creation now persists the Action Reference's Claimant thumbprint, stable Protected Action Type, immutable Action Policy revision, and bounded execution rules before calling the Gate Authority.

Redemption verifies Gate Pass and DPoP cryptography against keys loaded from the durable trust store, then one transaction consumes `(issuer, pass_id)`, consumes the proof identity, converges on one `(audience, Action Reference)` Redemption Record, creates one pending Protected Action Outcome, and inserts one execution intent. Concurrent valid passes converge and are each burned; consumed passes, replayed proofs, and Claimant conflicts fail without exposing an existing record.

Reference action workers use reclaimable leases, attempt/deadline bounds, retryable-error classes, and Action Reference idempotency. Account creation and terminal `succeeded` outcome commit atomically; exhausted or non-retryable execution becomes immutable `failed`. Fresh ES256 Claimant Outcome Proofs retrieve only existing `pending`, `succeeded`, or `failed` records during the 24-hour public window. PostgreSQL-backed public tests cover process restart, dropped Redemption and lookup responses, concurrent consumption, lease recovery, terminal success/failure, proof replay, and indistinguishable wrong-key/unknown lookups.
