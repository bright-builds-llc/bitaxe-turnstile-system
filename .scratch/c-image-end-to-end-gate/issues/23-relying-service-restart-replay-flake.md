# Relying-service restart test replays a pass that was never consumed

Type: bug
Status: resolved
Blocked by: None

## Objective

`relying_service_persistence`'s
`restart_rejects_consumed_pass_and_converges_new_pass_on_one_redemption` failed
once under `cargo test --all-features` while Ticket 13 was being verified. The
replayed first pass got 200 where 401 was expected (line 185).

The test sends the first redemption on a raw socket, sleeps a fixed 50 ms,
drops the socket and stops the Reference Service. Under load the redemption
may not have committed by then. Dropping the connection then cancels the
handler, so the first pass is never consumed, and the "replay" is in fact its
first use, which the service rightly accepts.

## Plan

- [x] Reproduce with loops: the single test, the whole binary, and the binary
  under load. Record the failure rates.
- [x] Wait for the first redemption's committed row in
  `relying_service.pass_consumptions` instead of sleeping, without weakening
  what the test asserts.
- [x] Check whether production code has a real defect here.
- [x] Loops are green after the fix, and the full checks pass.

## Answer

Only the tests changed. Production behaves as specified. `redeem` consumes the
pass in one transaction, which first locks the protected action `FOR UPDATE`.
So a redemption cancelled before commit leaves nothing behind, and if two
requests race, exactly one consumes the pass. In the failing runs the first
request never committed, so the 200 for the "replay" was correct.

- `tests/relying_service_persistence/durable_consumption.rs` polls every 20 ms,
  for up to 10 s, for a committed row. The restart test now waits for its
  `relying_service.pass_consumptions` row before it drops the unread response
  and stops the service. It still asserts 401 for the replay after restart and
  `pending` for the second pass. If the first redemption never commits, the
  test fails with a timeout instead of passing quietly.
- `outcome_lookup_returns_durable_success_without_reexecution` had the same
  50 ms sleep before its lost lookup. It now waits for its
  `relying_service.claimant_outcome_proofs` row. It never failed in these
  loops, but it raced the same way.

Rates on one machine. Each loop used a prebuilt test binary, copied before and
after the fix:

| Run | Before | After |
| --- | --- | --- |
| This test alone | 1 of 100 failed | 0 of 100 failed |
| Whole binary (6 tests) | 1 of 30 failed | 0 of 30 failed |
| Whole binary, 4 copies in parallel | 1 of 60 failed | 0 of 60 for this test (2 failures in other tests, see Comments) |

Every failure before the fix was this test, 200 for 401 at line 185. After the
fix the test passed all 190 times it ran.

## Comments

- 2026-11-11: two other failures appeared in the 4-copy loop after the fix.
  Neither test touches this change, and this ticket doesn't fix either one.
  - `expired_action_lease_recovers_one_immutable_success`: `unexpected response
    from SSLRequest: 0x00` when sqlx connected, with about 24 PostgreSQL
    containers starting at once. Like the Docker `PortNotExposed` one-off in
    Ticket 18, it comes from the container host, not the test.
  - `governance::outcome_lookup_survives_marker_retirement_until_aggregate_retention_floor`
    saw `pending` where it expected `succeeded` (`governance.rs:125`).
    `create_pending_redemption` reads `accepted_at` before it redeems. The
    service stamps `next_attempt_at` with its own clock, and `claim_action.sql`
    needs `next_attempt_at <= now`. If the second ticks between the two,
    `process_next_action(worker, accepted_at)` finds no work, and the test drops
    that result unchecked. `outcome_lookup_returns_durable_success_without_reexecution`
    has the same exposure. This needs its own ticket.
