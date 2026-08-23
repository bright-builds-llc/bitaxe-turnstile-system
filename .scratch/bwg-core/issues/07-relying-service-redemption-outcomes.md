# 07: Persist Redemption and Protected Action outcomes

**What to build:** PostgreSQL becomes authoritative for Relying Service Pass Consumption, Action Reference idempotency, Redemption Records, execution scheduling, and claimant-authenticated durable outcome retrieval.

**Blocked by:** 06: Persist Authority accounting and recover Gate Pass issuance.

**Status:** ready-for-agent

- [ ] The Relying Service owns a separate PostgreSQL schema, forward-only migrations, repository ports, and durable Trusted Authority Key Set without cross-context database access.
- [ ] Action References pin one Claimant-key thumbprint, Protected Action Type, and immutable Action Policy revision before challenge issuance.
- [ ] One transaction consumes `(issuer, pass_id)`, converges on one `(audience, Action Reference)` Redemption Record, creates one pending Protected Action Outcome, and inserts one Action Execution Intent.
- [ ] Later valid same-Claimant passes for the action are consumed and linked to the existing record without restarting execution; a conflicting Claimant key is rejected without consumption or disclosure.
- [ ] Action workers recover with durable leases and apply the policy-pinned deadline, attempt bound, retryable-error classes, and downstream Action Reference idempotency.
- [ ] Claimant-authenticated Outcome Lookup returns only safe `pending`, `succeeded`, or `failed` representations during its configurable public window and cannot authorize or restart an action.
- [ ] PostgreSQL-backed tests through public interfaces prove concurrent consumption, response loss, process restart, execution-worker lease recovery, immutable terminal outcomes, and indistinguishable unauthorized or unavailable lookups.
