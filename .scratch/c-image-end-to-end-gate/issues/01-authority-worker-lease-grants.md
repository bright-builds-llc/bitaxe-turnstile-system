# Authority issues signed Worker Lease grants and renewals

Type: task
Status: ready-for-agent
Blocked by: None

## Objective

The headless client forwards a `WorkerLeaseGrant` from the transport's Start or
Resume and asks `renewWorkerLease` for a `WorkerLeaseRenewal`, but no Authority
HTTP route returns either (`src/authority/http.rs`, `openapi/bwg-0.1.json`).
Make the Gate Authority issue them, so a Bitaxe's lease comes from the
challenge and not from a local signing CLI.

## Plan

- [ ] Confirm no other seam already does this (Core Tickets 10, 15 and 21, the
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
