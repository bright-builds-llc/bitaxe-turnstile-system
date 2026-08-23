# 06: Complete and redeem a proof-of-possession Gate Pass

**What to build:** Accepted work can satisfy a Work Challenge, produce a short-lived Gate Pass, and authorize one idempotent reference account-creation action only when the Claimant proves possession of the bound key.

**Blocked by:** 03: Prove Gate Pass cryptographic interoperability; 04: Secure challenge issuance and publish Authority discovery; 05: Credit accepted work and stream Verified Progress.

**Status:** claimed

- [ ] Threshold crossing creates durable Gate Pass issuance intent exactly once.
- [ ] The signed pass binds issuer, audience, challenge, Action Reference, Claimant key, issue time, expiry, and unique pass identity.
- [x] Redemption verifies the configured Authority, exact audience and action, unexpired pass, and fresh DPoP proof.
- [ ] The first valid Redemption atomically consumes the pass and creates one Redemption Record.
- [x] Concurrent, copied, wrong-key, wrong-action, wrong-audience, expired, and replayed requests fail safely.
- [ ] Response loss returns the same accepted action outcome without reauthorizing the pass.
- [ ] The acceptance harness proves the complete simulated issue-work-pass-redeem journey through public interfaces.

## Progress

Threshold crossing now records one stable Gate Pass issuance intent before signing. The intent fixes pass identity, challenge, issue time, and two-minute expiry; retries reuse it and repeated `GET /v0/challenges/{challenge_id}/gate-pass` returns the same compact Ed25519 JWS. The pass binds configured issuer, Relying Service audience, challenge, opaque Action Reference, Claimant P-256 JWK thumbprint, issue/expiry times, unique pass ID, and `BWG/0.1`.

The reference `POST /account-creation/redeem` verifies configured Authority keys, issuer, audience, Action Reference, pass time, ES256 DPoP signature, key confirmation, method, URI, `ath`, 60-second freshness, and proof replay. Its atomic transaction-shaped repository creates one Redemption Record per pass. Different fresh concurrent proofs converge on that record; a response-loss retry retrieves the same account outcome without re-execution, while copied, wrong-key/action/audience/issuer, expired, stale, wrong-URI, and replayed proofs fail closed.

The current harness generates a real P-256 Claimant key and proves direct Authority issue → exact Light work → intent/signing → pass retrieval → DPoP Redemption → stable retry through the Authority and reference-service HTTP interfaces plus the simulated Pool Adapter port. `bun run verify` passes.

## Blocker

Code review established that the remaining acceptance criteria require the PostgreSQL transaction/outbox and durable Redemption Record foundation currently assigned to Ticket 07, while Ticket 07 is declared blocked by this ticket. Process-local maps cannot truthfully satisfy durable exactly-once intent, crash-safe atomic consumption, or durable claimant-authenticated outcome lookup. The pass also still needs explicit Protected Action type binding, and the final acceptance harness must issue through the Reference Relying Service's Standard policy path.

Resolving this requires deliberately pulling the Ticket 07 persistence foundation forward into Ticket 06 (or changing the ticket dependency boundary) before further implementation.
