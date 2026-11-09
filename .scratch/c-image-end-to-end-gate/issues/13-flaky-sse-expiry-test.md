# Lifecycle SSE expiry test flakes under load

Type: bug
Status: resolved
Blocked by: None

## Objective

`lifecycle_control`'s `connected_lifecycle_sse_emits_expiry_at_the_absolute_deadline`
sets the deadline to the current second plus one. That leaves anywhere from a
few milliseconds to a second before expiry. A stream that subscribes after the
deadline never sees `active`. The expiry task also sleeps in whole seconds,
against a two-second read timeout. It failed 1 run in 15 before Ticket 11, and
more often under the full suite.

## Plan

- [x] Give the test a deadline with a fixed lead and a read timeout that covers
  the expiry task's whole-second sleep, without weakening what it asserts.
- [x] Repeated full-suite runs pass.

## Answer

Only the test changed. The production expiry path behaved as specified, and
there is no clock seam to inject, because the expiry task reads `SystemTime`.

- The deadline is now the current second plus 3 (`SSE_EXPIRY_LEAD_SECONDS`), a
  lead of 2 to 3 s for connecting, updating the row and opening both streams.
  If both streams aren't `active` before the deadline, the test fails with a
  message saying to raise the lead instead of timing out.
- The `expired` reads wait 6 s (`SSE_EXPIRY_READ_TIMEOUT`): the remaining lead,
  up to 1 s of whole-second wake-up after the deadline, and the database read.
  Other SSE reads keep the 2 s timeout.
- The test now also asserts that `expired` arrives no earlier than the deadline.

Rates, from the prebuilt test binary on one machine:

| Run | Before | After |
| --- | --- | --- |
| This test alone | 7 of 100 failed, all read timeouts | 0 of 100 failed |
| All 21 `lifecycle_control` tests in parallel | 2 of 30 runs failed, both this test timing out | 1 of 60 runs failed, not this test |

The one failure after the fix was `failed_session_is_observable_and_cannot_be_released`,
when Docker returned `PortNotExposed` while starting its container. That is the one-off
noted in Ticket 18. `cargo test --all-features` passed 5 of 6 runs after the
fix, and `lifecycle_control` passed in all 6. The other run failed in
`relying_service_persistence`, covered in the second comment below.

## Comments

- 2026-11-09: a narrow window remains in production, which this ticket doesn't
  cover. `subscribe_lifecycle` reads the snapshot before it subscribes to the
  broadcast channel. If an already scheduled expiry notifies between the two, a
  stream sees `active` and never sees `expired`. Subscribing before reading the
  snapshot would close it. The test's lead keeps it away from that window.
- 2026-11-09: a separate flake, outside this ticket. In one full-suite run,
  `relying_service_persistence`'s
  `restart_rejects_consumed_pass_and_converges_new_pass_on_one_redemption` got
  200 where it expected 401 for the replayed first pass (line 185). The test
  gives the lost first redemption a fixed 50 ms to reach the server before
  stopping it, so under load that redemption may never be consumed.
