# BWG/0.1 Gate Pass and Redemption

When exact Verified Progress first reaches a Work Challenge requirement, the PostgreSQL accounting transaction creates one immutable Gate Pass issuance intent and one signing-outbox record. The intent fixes a unique pass identity, challenge, claims template, algorithm, and signing deadline equal to Work Challenge expiry. A worker claims it with a short durable lease; expired leases are reclaimable, and an unsigned intent becomes permanently `failed` at its deadline.

The successful worker selects an eligible Ed25519 key, signs outside the accounting transaction, and atomically stores that `kid`, issue time, two-minute expiry, and exact compact JWS. The Gate Pass binds the configured Authority issuer, Relying Service audience, Work Challenge, stable Protected Action Type, immutable Action Policy revision, opaque Action Reference, Claimant P-256 JWK thumbprint, issue and expiry times, unique pass identity, and `BWG/0.1` version.

`GET /v0/challenges/{challenge_id}/gate-pass` requires a fresh ES256 Claimant Issuance Proof in `bwg-claimant-proof`. The proof binds its unique identity, issue time, `GET`, the public lookup URI, and exact Work Challenge ID; its public-key thumbprint must match the immutable challenge. Proof identities are durably consumed for their freshness window. Before the signed Gate Pass Retention Floor, the response is `pending`, `issued` with the exact stored JWS, or terminal `failed`; lookup never signs, retries, or extends a pass. After issued bytes are safely retired, lookup returns `410 Gone` with `issuance_retired` rather than recreating or misreporting the pass.

The reference Relying Service accepts `POST /account-creation/redeem` only when:

- the Gate Pass signature uses a separately configured trusted Authority key;
- issuer, audience, and exact Action Reference match operator and request context;
- a new action uses an unexpired, already-issued pass;
- the ES256 DPoP signature proves the bound Claimant key;
- DPoP method and URI match the Redemption endpoint;
- the proof is within the 60-second freshness window and its proof identity has not been used;
- the DPoP `ath` matches the exact compact Gate Pass.

The first valid Redemption transaction consumes `(issuer, pass_id)`, consumes the DPoP proof identity, creates one Redemption Record keyed by audience and Action Reference, creates a separate pending Protected Action Outcome, and inserts one execution intent. Later valid same-Claimant passes for that Action Reference are also consumed and linked to the existing record without restarting execution. A consumed pass cannot retrieve the record; response recovery uses Outcome Lookup.

The Reference Service's internal worker claims execution with a durable lease and applies the Action Policy's deadline, attempt bound, and retryable-error classes. Reference account creation uses the Action Reference as its idempotency key and commits with immutable terminal `succeeded`; exhausted or non-retryable execution commits immutable `failed`. Neither outcome changes Redemption acceptance or reverses Pass Consumption.

`GET /account-creation/outcomes/{action_reference}` requires a fresh `bwg-outcome-proof+jwt` in `bwg-claimant-proof`, bound to `GET`, the exact URI, issue time, unique proof identity, Action Reference, and the Redemption Record's Claimant key. It returns only the existing Redemption Record with `pending`, `succeeded`, or `failed` outcome during a configurable public window defaulting to 24 hours. Unknown references, wrong keys, and expired lookup windows are externally indistinguishable; lookup cannot authorize, execute, retry, or restart an action.

Replaying a proof, copying a pass or lookup proof to another key, or changing issuer, audience, action type, policy, reference, method, URI, or time fails closed.

Gate Authority and Relying Service persistence use separate schemas, migration histories, repository ports, and transactions even when deployed in one PostgreSQL cluster.
