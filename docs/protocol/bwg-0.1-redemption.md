# BWG/0.1 Gate Pass and Redemption

When exact Verified Progress first reaches a Work Challenge requirement, the PostgreSQL accounting transaction creates one immutable Gate Pass issuance intent and one signing-outbox record. The intent fixes a unique pass identity, challenge, claims template, algorithm, and signing deadline equal to Work Challenge expiry. A worker claims it with a short durable lease; expired leases are reclaimable, and an unsigned intent becomes permanently `failed` at its deadline.

The successful worker selects an eligible Ed25519 key, signs outside the accounting transaction, and atomically stores that `kid`, issue time, two-minute expiry, and exact compact JWS. The Gate Pass binds the configured Authority issuer, Relying Service audience, Work Challenge, stable Protected Action Type, immutable Action Policy revision, opaque Action Reference, Claimant P-256 JWK thumbprint, issue and expiry times, unique pass identity, and `BWG/0.1` version.

`GET /v0/challenges/{challenge_id}/gate-pass` requires a fresh ES256 Claimant Issuance Proof in `bwg-claimant-proof`. The proof binds its unique identity, issue time, `GET`, the public lookup URI, and exact Work Challenge ID; its public-key thumbprint must match the immutable challenge. Proof identities are durably consumed for their freshness window. The response is `pending`, `issued` with the exact stored JWS, or terminal `failed`; lookup never signs, retries, or extends a pass.

The reference Relying Service accepts `POST /account-creation/redeem` only when:

- the Gate Pass signature uses a separately configured trusted Authority key;
- issuer, audience, and exact Action Reference match operator and request context;
- a new action uses an unexpired, already-issued pass;
- the ES256 DPoP signature proves the bound Claimant key;
- DPoP method and URI match the Redemption endpoint;
- the proof is within the 60-second freshness window and its proof identity has not been used;
- the DPoP `ath` matches the exact compact Gate Pass.

The first valid Redemption atomically creates one account outcome keyed by pass identity. Concurrent requests with different fresh proofs converge on that same record. A response-loss retry with a new fresh proof retrieves the accepted outcome without executing the protected action again. Replaying one DPoP proof, copying the pass to another key, or changing issuer, audience, action, method, URI, or time fails closed.

Gate Authority intent, signing recovery, pass metadata, and lookup replay state are durable in PostgreSQL. Relying Service Pass Consumption, Redemption Records, and Protected Action Outcomes remain the separately owned persistence work in Ticket 07.
