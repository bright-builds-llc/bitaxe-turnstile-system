# Authority judges a Work Event by the reading at which it was observed

Type: task
Status: resolved
Blocked by: 10

## Objective

The Authority stops a Work Session when a delivered Accepted Work Event's lease
reading is lower than the last reading it recorded. A Renew records a newer
reading. So a share the Pool Adapter observed before a Renew but delivered after
it looks like a monotonic reset and ends the lease.

A related failure: accepted work writes its reading into the same column that
Start and Renew own. A share observed after the renewal hint but before the
Renew breaks the leased-session shape constraint and can't be recorded at all.

## Plan

- [x] A failing test reproduces delivery after a Renew.
- [x] The Authority judges each event by the lease window and its continuity,
  not by the last Renew or the order of delivery.
- [x] A reading that really runs backwards stays refused: below the lease start
  or under another continuity.
- [x] Replayed events and duplicate shares still earn no second credit.
- [x] Renew keeps refusing a reading below the last Start or Renew.

## Answer

Commits `475ecb2` and `8698c45`. Migration 0015 records the lease's start
reading. Accepted work must name the active lease and continuity, read no
earlier than that start, and fall before the current expiry. It no longer
writes a reading, so Renew and the lease-shape constraint are untouched by it.
`tests/late_work_delivery.rs` covers each case. Renew running backwards stays
covered in `tests/lifecycle_control/leases.rs`.

## Comments

2026-11-05. Red before the fix: delivery after a Renew gave
`WorkerContinuityLost`. A share past the renewal hint, and a Renew after it,
broke the `work_session_lease_shape` constraint.

Review: the first fix kept a high-water mark across accepted events. Outbox
delivery isn't ordered per session. `claim_next` skips locked rows, a failed
delivery waits out its lease while later events go through, and ties within one
second fall to event ID. So the bound is the lease start, and deduplication
stops double credit.

Delivery after the lease ended:
- After Pause or satisfaction it's refused and never credited.
- Work received before the challenge deadline is credited once if it arrives
  after the deadline but before anything records the expiry. Once the expiry is
  recorded, it's refused. Credit or drop is an owner decision; the test pins the
  current behavior.
- Each refusal comes back to the Pool Adapter as an error. The test sinks treat
  that as retryable, so a real delivery loop would retry it forever. Ticket 06's
  sink has to tell refusal from outage, which is a delivery-semantics decision.

Unrelated: `lifecycle_control`'s SSE expiry test also flakes on the previous
`HEAD` (1 of 15 runs). Its deadline is the current second plus one.
