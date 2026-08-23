# BWG Core Data-Governance Open Questions

These questions were resolved by the self-answered governance design tree in
[`data-governance-profile.md`](./data-governance-profile.md). They remain here as the preserved
decision surface that Ticket 09 originally exposed.

Ticket 09 cannot safely add export or deletion behavior until the following privileged contract is decided. These choices are intentionally separate from Claimant Issuance and Outcome Proofs, which authorize only bounded reads of one claimant-bound record.

## Operator authority

1. Which actor may export, pseudonymize, or delete Gate Authority and Relying Service records?
2. Is the first profile local-operator-only, or is a remote operator interface required?
3. What credential and fresh-authentication level authorizes each operation?
4. Are Gate Authority and Relying Service privileges necessarily separate when deployments share a PostgreSQL cluster?

## Retention classes

Define an explicit duration and expiry action for each class:

| Context | Record class | Already-established lower bound | Missing decision |
| --- | --- | --- | --- |
| Gate Authority | Claimant issuance proof replay IDs | Proof freshness plus skew | None if worker cleanup remains authoritative |
| Gate Authority | Signed Gate Pass bytes | Pass expiry plus skew | Delete bytes, tombstone, or retain for audit |
| Gate Authority | Challenge policy and Accepted Work Events | Required for reconstruction and stable acknowledgements | Audit duration and eventual pseudonymization/deletion |
| Gate Authority | Issuance intent/outbox metadata | Required through terminal issuance | Audit duration after terminal state |
| Relying Service | DPoP and Outcome proof replay IDs | Proof freshness plus skew | None if worker cleanup remains authoritative |
| Relying Service | Pass Consumption markers | Until no conforming verifier could accept the pass | Audit duration after replay-safety bound |
| Relying Service | Redemption Records and outcomes | Public lookup window is independently bounded | Product/audit duration and expiry action |
| Relying Service | Action attempts and execution intents | Through immutable terminal outcome | Operational audit duration |

## Deletion semantics

1. Which append-only accounting facts may be physically deleted?
2. Which facts require a non-identifying tombstone to preserve deduplication, reconstruction, or audit integrity?
3. Does deletion mean row removal, cryptographic erasure, field-level pseudonymization, or loss of claimant-facing availability?
4. How are referential integrity and stable replay acknowledgements preserved after cleanup?
5. Must self-hosters be able to choose stricter or longer policies, and which protocol guarantees remain mandatory?

## Export and audit contracts

1. Define the versioned export media type and schema for each context.
2. Decide whether exports contain raw opaque identifiers, salted/pseudonymous identifiers, or aggregates only.
3. Define audit event types for request, authorization, completion, failure, and operator action without storing credentials, private keys, action payloads, payout data, network secrets, Account Identity, or Device Identity.
4. Define pagination, snapshot consistency, redaction, provenance, and integrity-signature requirements.
5. Decide whether export itself creates a separately retained audit event.

## Incident and failure behavior

1. What happens when cleanup partially succeeds across related rows?
2. Can a failed export be safely resumed without duplicating or omitting records?
3. Which retention/deletion failures are operator-visible, and through what non-secret telemetry?
4. What recovery evidence is required before enabling destructive cleanup in hosted deployments?

## Existing constraints

- PostgreSQL schemas, migrations, repositories, and transactions remain context-local.
- No cross-context transaction or foreign key may be introduced.
- Claimant proofs cannot become operator credentials.
- Terminal Redemption and Protected Action facts cannot be rewritten or reopened.
- Public lookup expiry is not evidence that internal deletion is safe.
- Age or storage pressure alone cannot override replay safety or immutable audit requirements.
