# BWG/0.1 Gate Pass and Redemption

When exact Verified Progress first reaches a Work Challenge requirement, the accounting transaction creates one Gate Pass issuance intent. The intent fixes a unique pass identity, challenge, issue time, and two-minute expiry before signing. Signing retries reuse that intent, so repeated pass retrieval returns the same compact JWS rather than minting another authorization.

The Ed25519 Gate Pass binds the configured Authority issuer, Relying Service audience, Work Challenge, opaque Action Reference, Claimant P-256 JWK thumbprint, issue and expiry times, unique pass identity, and `BWG/0.1` version. `GET /v0/challenges/{challenge_id}/gate-pass` returns the issued pass or an explicit pending outcome.

The reference Relying Service accepts `POST /account-creation/redeem` only when:

- the Gate Pass signature uses a separately configured trusted Authority key;
- issuer, audience, and exact Action Reference match operator and request context;
- a new action uses an unexpired, already-issued pass;
- the ES256 DPoP signature proves the bound Claimant key;
- DPoP method and URI match the Redemption endpoint;
- the proof is within the 60-second freshness window and its proof identity has not been used;
- the DPoP `ath` matches the exact compact Gate Pass.

The first valid Redemption atomically creates one account outcome keyed by pass identity. Concurrent requests with different fresh proofs converge on that same record. A response-loss retry with a new fresh proof retrieves the accepted outcome without executing the protected action again. Replaying one DPoP proof, copying the pass to another key, or changing issuer, audience, action, method, URI, or time fails closed.

This phase keeps the intent and Redemption Record behind transaction-shaped in-memory ports for the complete simulated public journey. The persistent-lifecycle phase moves those records into PostgreSQL without changing the signing, consumption, idempotency, or outcome-retrieval semantics.
