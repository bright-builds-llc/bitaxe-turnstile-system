# An adapter restart replays nothing creditable twice

Type: task
Status: ready-for-agent
Blocked by: None

## Objective

Criterion 11 and Core Ticket 23 ask that an adapter restart which keeps its
outbox replays nothing creditable twice. Under ADR-0109 the Pool Adapter runs
inside `gate-authority`, so a restart means restarting that process.

Each piece is tested on its own today:
- the outbox reclaim (`tests/stratum_v1_proxy/persistence.rs`);
- delivery (`authority_delivery.rs`);
- the Authority's deduplication (`authority_persistence.rs`, `accepted_work_progress.rs`).

No test restarts the in-process adapter from end to end. The owner chose
(2026-11-14) a Rust test now, with hardware as a non-claim.

## Plan

- [ ] An end-to-end Rust test:
  - a share is accepted into `pool_adapter.accepted_work_outbox`;
  - `gate-authority`'s adapter stops before delivery is acknowledged;
  - it restarts on the same database;
  - the reclaimed event is credited exactly once;
  - an event that was already acknowledged is not credited again.
- [ ] The test runs in `bun run verify` and passes 50 runs in a loop.
- [ ] Ticket 16's plan runs it again against the separate adapter process.

## Comments
