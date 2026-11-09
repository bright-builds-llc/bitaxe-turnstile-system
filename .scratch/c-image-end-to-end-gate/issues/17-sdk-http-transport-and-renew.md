# SDK claimant HTTP transport and component-owned Renew

Type: task
Status: resolved
Blocked by: 06

## Objective

The SDK has no HTTP `HeadlessTransport`, and nothing in the component calls
`renewWorkerLease`. Ticket 06's reference page does both in its own code, which
a real site would have to copy. Move them into `bwg-core`.

## Plan

- [x] An exported claimant HTTP transport for the Work Session, Pool Selection,
  events and Gate Pass routes, with its proofs.
- [x] The component renews on the lifecycle's renewal cadence while Worker
  continuity holds, and stops on any refusal.
- [x] Ticket 06's page uses them instead of its own code, and the rehearsal
  still passes.

## Answer

`bwg-core/headless` exports `createClaimantHttpTransport`
(`web/claimant-http-transport.ts`) and `renewWorkerLeaseWhileRunning`
(`web/worker-lease-renewal.ts`). The transport signs Work Session and Pool
Selection requests with the Claimant key, reads the event stream, looks up the
Gate Pass with an Issuance Proof, and signs the redemption's DPoP proof. Renew
runs every 20 s on `pageClock()` while work runs, skips while paused, and stops
on any refusal. `<bwg-work-gate>` starts it for each session and stops it when
the session ends or is replaced; `maybeOnRenewal` reports each outcome.

The slow-restore race is fixed in the client. It now emits `terminal_reported`
once, when the Authority reports a terminal state and before restoration
settles, and Renew stops on it. A Renew already in flight then sends nothing
more to the Controller: neither its renewal nor a `control_failed` rollback, so
the terminal restore stays the last command.

The reference page uses the transport and the gate's Renew. It still releases
the port after redemption and keeps its status text and page events. The
rehearsal passes.

Non-claims: if the Authority refuses a Renew before its terminal event reaches
the page, the client still rolls back as for any refusal. That window is shorter
than one event delivery and wasn't seen.

## Comments
