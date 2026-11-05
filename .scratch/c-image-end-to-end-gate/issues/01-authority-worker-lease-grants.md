# Authority issues signed Worker Lease grants and renewals

Type: task
Status: needs-info
Blocked by: None

## Objective

The headless client forwards a `WorkerLeaseGrant` from the transport's Start or
Resume and asks `renewWorkerLease` for a `WorkerLeaseRenewal`, but no Authority
HTTP route returns either (`src/authority/http.rs`, `openapi/bwg-0.1.json`).
Make the Gate Authority issue them, so a Bitaxe's lease comes from the
challenge and not from a local signing CLI.

## Plan

- [x] Confirm no other seam already does this (Core Tickets 10, 15 and 21, the
  headless and Worker Controller protocol docs), and record what was found.
- [ ] On Start and Resume for a possession-bound Worker, return a grant whose
  `stratum` names the Pool Adapter's lease-scoped Stratum V1 credentials, signed
  under ADR-0093: the authorizationless request digest with the active Challenge
  binding, the control-session digest, and a durable monotonic sequence per key.
- [ ] Add a Renew route on the same lease, refused after Pause, Cancel, expiry or
  lost continuity.
- [ ] Load the Work Lease Authority key as a deployment secret, separate from the
  Gate Pass and Update Authority keys. Tests and fixtures use test keys only.
- [ ] Update OpenAPI, the headless client doc and conformance vectors, and run
  `bun run verify`.

## Comments

2026-11-05: No seam does this, and the gap is wider than the Objective says. The
Authority HTTP router has no claimant Start, Resume or Renew route at all. Pool
Selection propose and confirm, Work Session creation, `start_lease`,
`start_lease_with_trusted_consent` and `renew_lease` exist only on the in-process
`SimulatedPoolAdapter`, which `src/authority_application/pool_adapter.rs` calls a
stand-in for the future gRPC transport. Pause and Cancel need a Relying Service
credential, which the headless module never holds. The headless doc leaves the
transport to the caller, and every caller so far is a test harness. The Stratum V1
credentials (`src/stratum_v1/credentials.rs`) and the Worker Lease signer
(`web/worker-lease-authorization.ts`, profile 0.2, audience Controller 0.4) exist,
but nothing joins them to a challenge.

Proposed design, waiting on a go-ahead because it sets a public contract and its
authentication: claimant routes under `/v0/challenges/{challenge_id}/work-session`,
authenticated by the claimant proof the Gate Pass lookup already uses, for Pool
Selection propose and confirm, Start (possession digest, Worker continuity ID and
monotonic reading, optional Trusted Consent receipt), Resume as Start on a paused
session, and Renew. Start and Resume return a `WorkerLeaseGrant` whose `stratum`
carries the Pool Adapter's lease-scoped credentials; Renew returns a
`WorkerLeaseRenewal`. A Rust signer emits the same compact JWS as the TypeScript
one, proved by shared vectors that the TypeScript verifier accepts. Each key's
sequence lives in a new PostgreSQL table, and the key loads from its own
deployment secret. A new ADR records the claimant routes. Claimant Pause and
Cancel stay open: either the Relying Service proxies them or these routes add
them.
