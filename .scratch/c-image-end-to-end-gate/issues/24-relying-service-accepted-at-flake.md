# Relying-service tests run the action worker before the service's acceptance second

Type: bug
Status: resolved
Blocked by: None

## Objective

Found in Ticket 23's loops (see its Comments). In `tests/relying_service_persistence.rs`,
`create_pending_redemption` reads `accepted_at` from the test's clock, then redeems. The
Reference Service reads its own clock when it accepts the redemption
(`redeem_account_creation` in `src/reference_service.rs`), records it as
`accepted_at_unix_seconds` (`src/reference_application.rs`, around line 134), and stamps the
execution intent's `next_attempt_at_unix_seconds` with the same value. `claim_action.sql`
claims only intents with `next_attempt_at_unix_seconds <= now`.

If the second ticks between the test's clock read and the service's, the test's
`accepted_at` is one second early. `process_next_action(worker, pending.accepted_at)` then
finds no intent and returns `NoWork`:

- `governance::outcome_lookup_survives_marker_retirement_until_aggregate_retention_floor` and
  `outcome_lookup_returns_durable_success_without_reexecution` drop that result. The action
  never runs, and the outcome stays `pending`. Observed once, 1 of 60 runs with 4 copies of the
  binary in parallel: `governance.rs:125` saw `pending` where it expected `succeeded`.
- `expired_action_lease_recovers_one_immutable_success` and
  `exhausted_action_attempts_create_one_immutable_failure` expect `ExecutionUnavailable` from
  their first call at `accepted_at` and would get `Ok(NoWork)`. Every later offset they use
  (`+1`, `+31`, `+93`, …) is also one second short.

## Plan

- [x] Confirm the mechanism in code, and check whether production has a real defect.
- [x] Measure the failure rate before the fix with loops, and induce the race to show it
  deterministically.
- [x] Take `accepted_at` from the redemption response's `accepted_at_unix_seconds`, the
  service's own record, and keep the test's clock only for signing the Gate Pass and DPoP
  proof.
- [x] Assert the executor's outcome where a test relies on it, so a skipped execution fails
  at its cause instead of at a later status check.
- [x] Loops are green after the fix, and the full checks pass.

## Answer

Only the tests changed. Production behaves as specified. The service's acceptance second is
the authoritative start of execution, and its own worker reads the clock on every 250 ms tick
(`src/bin/reference-service.rs`), so an intent accepted in second `s` is claimed on the first
tick at or after `s`. Only the tests passed in an earlier `now`, read from their own clock.

- `create_pending_redemption` now takes `PendingRedemption::accepted_at` from the redemption
  response's `accepted_at_unix_seconds`, which is the value the service stored as both
  `accepted_at_unix_seconds` and the intent's `next_attempt_at_unix_seconds`. The test's clock
  read is renamed `issued_at`, and only signs the Gate Pass and DPoP proof. Every test that
  steps the worker by offsets from `accepted_at` now steps from the service's own second.
- `outcome_lookup_returns_durable_success_without_reexecution` and
  `governance::outcome_lookup_survives_marker_retirement_until_aggregate_retention_floor` now
  assert that their executor call returned `Succeeded` for this redemption, instead of dropping
  the result. A skipped execution now fails at that call, not at a later `pending` status.
- `expired_action_lease_recovers_one_immutable_success` compares its recovered outcome with
  `assert_eq!` instead of `matches!`, so a mismatch prints both values. No assertion was removed
  or loosened.
- The new assertions took `tests/relying_service_persistence.rs` past the 628-line standard, so
  `expired_action_lease_recovers_one_immutable_success` and
  `exhausted_action_attempts_create_one_immutable_failure` moved, unchanged apart from the line
  above, to `tests/relying_service_persistence/action_execution.rs`, as `governance.rs` already
  is. Their names in test output gain the `action_execution::` prefix.

Rates on one machine. Each loop used a prebuilt test binary. To isolate this race from Ticket
23's (not on `main` yet), every measurement binary carried Ticket 23's test-only change as a
temporary, uncommitted patch, so the only difference between before and after is this fix.

| Run | Before | After |
| --- | --- | --- |
| Race induced: sleep past the next second right after the test reads its clock (temporary patch) | 10 of 10 runs failed, all 4 exposed tests each time | 0 of 10 failed |
| Whole binary (6 tests), 4 copies in parallel, 50 rounds | 1 of 200 failed, not this race (see Comments) | 1 of 200 failed, not this race (see Comments) |

With the race induced, before the fix, the four exposed tests failed in every run:
`governance.rs:125` saw `pending` for `succeeded`, the outcome-lookup test saw `pending` too, and
`expired_action_lease_recovers_one_immutable_success` and
`exhausted_action_attempts_create_one_immutable_failure` got `Ok(NoWork)` where they expected
`ExecutionUnavailable`. The natural window is the few milliseconds between the test's clock read
and the service's, so it didn't recur in these 200 runs; Ticket 23's loop saw it once in 60.

Checks: `cargo fmt --all`, `cargo clippy --all-targets --all-features -- -D warnings`,
`cargo build --all-targets --all-features`, `cargo test --all-features` and
`bun run check:standards`.

Non-claims: if the worker and the HTTP handler ran on hosts with skewed clocks, an intent would
wait for the worker's clock to reach the acceptance second. That's unchanged and outside these
tests.

## Comments

- 2026-11-11: two other failures appeared in the natural loops. Neither is this race, and this
  ticket doesn't fix either one.
  - Before the fix: `governance::outcome_lookup_survives_marker_retirement_until_aggregate_retention_floor`
    failed at `governance.rs:136`, `assert!(aggregate_apply.status.success())`. The outcome had
    already reached `succeeded`, so the executor ran. The second `apply-retention` run of
    `reference-service-governance` exited non-zero, and the test keeps that process's stderr
    unread, so the cause isn't known. A follow-up should print the child's stderr on failure
    and loop it.
  - After the fix: `action_reference_rejects_a_different_claimant_key` failed with Docker
    `PortNotExposed` for 5432 at container start, the same container-host failure as in Ticket
    18, before any test code ran.
