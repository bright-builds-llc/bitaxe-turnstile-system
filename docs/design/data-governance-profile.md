# BWG/0.1 Data-Governance Decision Tree

The user authorized the recommended answer to every grilling question. This record preserves the
full decision frontier and the rationale that closes it; the normative behavior is summarized in
[`bwg-0.1-data-governance.md`](../protocol/bwg-0.1-data-governance.md).

## Round 1: authority and boundaries

### Q1: Who may govern BWG records?

**Answer:** A Service-Local Operator with host access and a least-privileged database role scoped
to one persistence context.

**Rationale:** Export, pseudonymization, and deletion are privileged operational actions. A
Claimant proof authorizes only one bounded read and must never grow into an administrator token.

### Q2: Is a remote operator interface required?

**Answer:** No. BWG/0.1 exposes separate Gate Authority and Relying Service command-line
interfaces and no remote administrative HTTP routes.

**Rationale:** A remote interface would require a new authentication, authorization, revocation,
and network threat model that the protocol does not need to resolve its current lifecycle gap.

### Q3: May one operation span both contexts?

**Answer:** No. A deployment may orchestrate two commands, but each job, manifest, cursor, audit
event, database role, and transaction remains context-local.

**Rationale:** Independent recovery preserves the established Authority/Relying Service
availability boundary and avoids cross-schema coupling.

## Round 2: retention and retirement

### Q4: What are the hosted retention periods?

**Answer:** Protocol-specific replay and artifact safety floors always apply first. Reusable proof
and signed-pass bytes are deleted as soon as their floor passes. Other terminal operational records
remain identifying through day 30, become Pseudonymized Tombstones through day 90, and are then
physically deleted. Governance audit events are retained for 90 days.

**Rationale:** Thirty days provides bounded incident and operational evidence without treating a
24-hour public lookup window as a deletion signal. Ninety days preserves temporary audit integrity
without creating indefinite identity history.

### Q5: May a deployment change those periods?

**Answer:** A deployment may extend them but cannot configure any transition below an applicable
Retention Floor.

**Rationale:** Product policy may be stricter about preservation, but storage pressure or operator
preference cannot weaken replay safety or immutable-outcome guarantees.

### Q6: What does deletion mean?

**Answer:** Reusable proofs, signed artifacts, secret-bearing fields, and payload-like details are
physically removed once safe. Identifying operational references are replaced at day 30 by
context-local keyed-HMAC pseudonyms and minimal terminal facts; those tombstones are removed at day
90.

**Rationale:** Field-level erasure preserves bounded terminal and deduplication evidence while
making the original Claimant or Action Reference unavailable without the non-exported context key.

### Q7: May immutable outcomes be rewritten?

**Answer:** No. While a Redemption Record and Protected Action Outcome remain in their operational
form, their terminal state never changes. Pseudonymization is a separate governance transition into
a Pseudonymized Tombstone, not a reopening or alternate outcome.

**Rationale:** Lifecycle retirement must not blur authorization acceptance with action execution or
weaken terminal immutability.

## Round 3: planning and destructive execution

### Q8: How is cleanup authorized?

**Answer:** `plan-retention` is read-only with respect to governed domain records, but it may write
context-local job and Governance Manifest metadata needed to bind a later apply. `apply-retention`
requires destructive mode to be explicitly enabled, the exact SHA-256 manifest digest, and an
explicit confirmation flag.

**Rationale:** A reviewed dry run and digest binding make stale or changed plans fail closed before
an irreversible effect.

### Q9: How large is one cleanup operation?

**Answer:** Every job advances in bounded, context-local database transactions, persists its cursor,
and is safe to retry with the same manifest.

**Rationale:** A process crash can lose only uncommitted work, while committed batches are not
repeated or inferred from logs.

### Q10: What happens when related rows cannot be retired safely?

**Answer:** The batch rolls back, records a non-secret failure category, leaves the cursor at its
last committed position, and requires a retry of the same manifest or a newly reviewed plan.

**Rationale:** Partial referential cleanup must be visible and resumable rather than silently
skipping records or weakening invariants.

## Round 4: export and audit

### Q11: What is the export contract?

**Answer:** Each context emits `application/x-ndjson; profile="bwg-governance-v1"` from a stable
Snapshot Cutoff. Every envelope contains the schema version, context, export ID, cutoff, sequence,
record type, and redacted payload. A final SHA-256 manifest binds counts, bytes, and content digest.

**Rationale:** NDJSON supports bounded streaming and resume while a fixed cutoff prevents later
pages from observing a different database state.

### Q12: Which identifiers are exportable?

**Answer:** Export envelopes use context-local pseudonyms. Credentials, JWKs, signed proofs or
passes, action payloads, payout/network/device/account identity, and pseudonymization keys are never
exported.

**Rationale:** Opaque identifiers can still correlate activity; pseudonyms provide local grouping
without turning the export into an identity bridge.

### Q13: Is export audited?

**Answer:** Yes. Start, completion, and failure events record only operation metadata, counts,
duration, digest, context, and safe error category.

**Rationale:** Export is itself a privileged disclosure boundary, but auditing it must not duplicate
the disclosed records or credentials.

## Round 5: incidents and rollout

### Q14: How does cross-context partial failure behave?

**Answer:** Each context reports and recovers independently. Success in one context never commits,
rolls back, or authorizes work in the other.

**Rationale:** The operational model must match the existing persistence boundary rather than imply
a distributed transaction.

### Q15: What evidence is required before destructive cleanup is enabled?

**Answer:** Additive migrations and dry-run planning ship first. Representative manifests, safety
floor rejections, restart tests, prohibited-data scans, and context-isolation tests must pass before
an operator explicitly enables destructive apply.

**Rationale:** Shadow planning provides pre-effect evidence at every unresolved boundary without
turning general caution into a permanent stage gate.

### Q16: Is this a regulatory compliance profile?

**Answer:** No. It is a technical BWG record-governance profile. Jurisdiction-specific product or
account retention remains outside this effort.

**Rationale:** The repository has no deployment jurisdiction or legal retention source from which a
compliance claim could be derived.
