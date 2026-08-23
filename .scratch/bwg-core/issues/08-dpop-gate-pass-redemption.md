# 08: Complete and redeem a proof-of-possession Gate Pass

**What to build:** Accepted work can satisfy a Work Challenge, produce a short-lived Gate Pass, and authorize one idempotent reference account-creation action only when the Claimant proves possession of the bound key.

**Blocked by:** 06: Persist Authority accounting and recover Gate Pass issuance; 07: Persist Redemption and Protected Action outcomes.

**Status:** ready-for-agent

- [ ] The signed pass binds issuer, audience, challenge, Protected Action Type, Action Reference, immutable Action Policy revision, Claimant key, issue time, expiry, and unique pass identity.
- [x] Redemption verifies the configured Authority, exact audience and action, unexpired pass, and fresh DPoP proof.
- [x] Concurrent, copied, wrong-key, wrong-action, wrong-audience, expired, and replayed requests fail safely.
- [ ] Issuance and Outcome Lookup use their dedicated claimant proof profiles and expose only their bounded read semantics.
- [ ] OpenAPI and interoperability fixtures cover the final pass, proof, Redemption, issuance-state, and outcome-state wire contracts.
- [ ] The acceptance harness proves the complete simulated Standard-policy issue-work-pass-redeem-outcome journey through public interfaces.

## Progress

The pre-persistence implementation records one process-local Gate Pass issuance intent before signing. It fixes pass identity, challenge, issue time, and two-minute expiry; retries reuse it and repeated `GET /v0/challenges/{challenge_id}/gate-pass` returns the same compact Ed25519 JWS. The pass binds configured issuer, Relying Service audience, challenge, opaque Action Reference, Claimant P-256 JWK thumbprint, issue/expiry times, unique pass ID, and `BWG/0.1`.

The reference `POST /account-creation/redeem` verifies configured Authority keys, issuer, audience, Action Reference, pass time, ES256 DPoP signature, key confirmation, method, URI, `ath`, 60-second freshness, and proof replay. Its process-local transaction-shaped repository creates one Redemption Record per pass. Different fresh concurrent proofs converge on that record; a response-loss retry retrieves the same account outcome without re-execution, while copied, wrong-key/action/audience/issuer, expired, stale, wrong-URI, and replayed proofs fail closed.

The current harness generates a real P-256 Claimant key and proves direct Authority issue → exact Light work → intent/signing → pass retrieval → DPoP Redemption → stable retry through the Authority and reference-service HTTP interfaces plus the simulated Pool Adapter port. `bun run verify` passes.

## Restructuring

The former Ticket 06 was split after review exposed a dependency cycle with the former Ticket 07. New Tickets 06 and 07 now own the Authority and Relying Service persistence foundations respectively; this ticket retains the completed cryptographic and process-local protocol work and finishes the public protocol only after those foundations exist.
