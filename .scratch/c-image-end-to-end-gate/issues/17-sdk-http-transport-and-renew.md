# SDK claimant HTTP transport and component-owned Renew

Type: task
Status: ready-for-agent
Blocked by: 06

## Objective

The SDK has no HTTP `HeadlessTransport`, and nothing in the component calls
`renewWorkerLease`. Ticket 06's reference page does both in its own code, which
a real site would have to copy. Move them into `bwg-core`.

## Plan

- [ ] An exported claimant HTTP transport for the Work Session, Pool Selection,
  events and Gate Pass routes, with its proofs.
- [ ] The component renews on the lifecycle's renewal cadence while Worker
  continuity holds, and stops on any refusal.
- [ ] Ticket 06's page uses them instead of its own code, and the rehearsal
  still passes.

## Comments
