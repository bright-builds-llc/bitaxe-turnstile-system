# An adapter restart replays nothing creditable twice

Type: task
Status: resolved
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

- [x] An end-to-end Rust test:
  - a share is accepted into `pool_adapter.accepted_work_outbox`;
  - `gate-authority`'s adapter stops before delivery is acknowledged;
  - it restarts on the same database;
  - the reclaimed event is credited exactly once;
  - an event that was already acknowledged is not credited again.
- [x] The test runs in `bun run verify` and passes 50 runs in a loop.
- [x] Ticket 16's plan runs it again against the separate adapter process.

## Comments

## Answer

No double credit. Only tests changed.

`tests/stratum_v1_proxy/adapter_restart.rs` holds
`restarted_adapter_credits_its_reclaimed_event_once_and_never_replays_acknowledged_work`.
It runs in the `stratum_v1_proxy` binary, so `cargo test --all-features` in
`bun run verify` runs it. It uses the real in-process adapter
(`spawn_in_process_pool_adapter`) and the Authority's in-process port
(`SimulatedPoolAdapter`):

1. A Worker connects to the adapter's listener with Stratum credentials for a
   leased Work Session. A test Mining Pool sends a job and accepts each share.
2. The first share is persisted in `pool_adapter.accepted_work_outbox`,
   delivered and acknowledged.
3. The second share is persisted and delivered, and the Authority credits it.
   The port then never returns, so the outbox is not told. Dropping the
   adapter's tasks stops it with the event still claimed and pending.
4. The test checks that exactly one claim is left unacknowledged. It moves that
   claim's 30 s delivery lease back by 30 s. That stands for the time the
   process is down, so the test does not wait 30 s.
5. A new `AuthorityApplication` and a new adapter start on the same database.

After the restarted adapter settles the outbox, plus one quiet second:
- it delivered only the reclaimed event, and never the acknowledged one;
- the reclaimed event is `acknowledged` after two claims;
- `gate_authority.accepted_work_events` has exactly two rows, one per event,
  both `credited`;
- the challenge's verified progress is the sum of their credits. A second
  credit for the reclaimed event would break this.

The Authority returns its stored acknowledgement on redelivery, because
`accept_work` looks the event up by `event_id` first.

Checked against two deliberate breaks, then reverted:
- A restart that resets acknowledged outbox rows to `pending`: fails in 3 of 3
  runs, because the restarted adapter delivers both events. The Authority still
  credited each event once, through its replay lookup.
- An Authority without the replay lookup: fails, because the reclaimed event
  never settles.

The first draft asserted as soon as the reclaimed event was acknowledged, and
missed the first break. Event IDs do not sort by arrival within a second, so
the replayed event could come second. The test now waits until nothing is
pending and then stays quiet for 1 s.

Loop: 50 of 50 passed, using one prebuilt `stratum_v1_proxy` test binary filtered to
`adapter_restart`, each run about 3.5 s on one machine.

`tests/stratum_v1_proxy/authority_delivery.rs` gained `leased_authority`, a
helper that issues a challenge, registers a session and starts its lease. Its
first test now uses it.

Non-claims and notes:
- No hardware. The owner chose a Rust test (2026-11-14).
- The Authority restarts with the adapter, as `gate-authority` does under
  ADR-0109. Ticket 16 reruns this restarting only the adapter.
- Dropping the `JoinSet` from `spawn_in_process_pool_adapter` stops the accept
  loop, delivery and the sweep, but not live Stratum sessions. `accept_workers`
  starts those with a detached `tokio::spawn`. Here the Worker stays connected
  and idle until the end. In `gate-authority` the process exit ends them.
