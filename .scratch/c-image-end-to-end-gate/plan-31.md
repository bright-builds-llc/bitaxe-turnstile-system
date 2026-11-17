# Ticket 31 Pool Adapter retention: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Pool Adapter's expired session, connection and settled share records get deleted,
by an operator command or by an opt-in timer, both on the existing `retire`.

**Architecture:** `src/stratum_v1/retention.rs` gains a count, a run-to-completion loop and
lock skipping. A pure settings parser decides whether the Pool Adapter process runs a retention
sweep beside its Pool Selection sweep. A new `pool-adapter-governance` binary counts and deletes
on the operator's word. The profile and the privacy page then state the schedule.

**Tech Stack:** Rust (tokio, sqlx/Postgres, serde), Bun for the page test.

**Spec:** `.scratch/c-image-end-to-end-gate/issues/31-pool-adapter-retention.md`, section
"Design (approved by the owner 2026-11-16)".

## Global Constraints

- The floor stays `HOSTED_OPERATIONAL_RETENTION_SECONDS` (30 days); nothing accepts less.
- Batches are 1 to 1,000 rows per table (`MAXIMUM_RETENTION_BATCH_ROWS`).
- `BWG_POOL_ADAPTER_RETENTION_INTERVAL_SECONDS`: 60 to 86,400. Unset means off.
- `BWG_POOL_ADAPTER_RETENTION_SECONDS`: defaults to the floor, can't be lower.
- The sweep runs only with the interval set **and** `BWG_GOVERNANCE_DESTRUCTIVE_ENABLED=true`.
- `delete-expired` needs `BWG_GOVERNANCE_DESTRUCTIVE_ENABLED=true` and `--confirm-destruction`,
  checked before connecting to the database.
- The binary reads only `BWG_POOL_ADAPTER_DATABASE_URL` for its database.
- Output and logs carry counts only: no record identifiers, credentials or payout data.
- An unsettled share record (`delivery_state` not `acknowledged`/`refused`) is never deleted.

## Review Focus

- An unsettled share record older than the cutoff must survive every route. Task 1 tests it.
- `count-expired` must report exactly what `delete-expired` then deletes, including sessions whose
  connections go first. Task 1 tests count against the run's totals.
- A row another transaction holds must not stall a run. Task 1 tests it with a held lock and a
  2 s deadline.
- A malformed or out-of-range setting must stop the process at start, even with the switch off.
  Task 2 tests the parser and the binary's exit.
- The sweep's first run happens at start (tokio's first tick is immediate), so an operator who
  turns it on sees expired records go without waiting a whole interval. Task 2's process test
  relies on it.

---

### Task 1: Count, run to completion, skip locked rows

**Files:**
- Modify: `src/stratum_v1/retention.rs`
- Test: `tests/stratum_v1_proxy/retention.rs`

**Interfaces:**
- Produces:
  - `PoolAdapterRetentionCounts` gains `serde::Serialize` and
    `fn is_empty(&self) -> bool` (all three zero).
  - `PostgresPoolAdapterRetention::count_expired(&self, as_of_unix_seconds: u64,
    retention_seconds: u64) -> Result<PoolAdapterRetentionCounts, StratumV1Error>`: what a full
    run would delete, changing nothing. Connections by the same rule as `retire`'s first query;
    sessions with `expires_at_unix_seconds <= cutoff`; settled events by `retire`'s rule.
  - `PostgresPoolAdapterRetention::retire_until_done(&self, as_of_unix_seconds: u64,
    retention_seconds: u64, maximum_rows_per_table: u64)
    -> Result<PoolAdapterRetentionCounts, StratumV1Error>`: calls `retire` until a batch is
    empty, returning the summed counts.
  - The same policy checks as `retire` (future `as_of`, below floor) in one private function
    both use.

- [ ] **Step 1: Write the failing tests** in `tests/stratum_v1_proxy/retention.rs`, reusing the
  existing test's setup (extract its arrange into a helper that seeds one expired session with
  two connections and one settled event):
  - `pool_adapter_count_matches_what_a_full_run_deletes`: `count_expired` before is
    `{connections: 2, sessions: 1, settled_events: 1}`; then `retire_until_done(.., 1)` (batch of
    one, so it loops) returns the same counts; `count_expired` after is empty.
  - `pool_adapter_count_rejects_a_future_instant_and_a_short_period`: both return
    `Err(StratumV1Error::InvalidRetentionPolicy)`.
  - `pool_adapter_retirement_keeps_unsettled_share_records`: persist an event, leave it pending
    (and a second claimed but not acknowledged), with `as_of` past the floor; after
    `retire_until_done` both are still claimable or held, and `settled_events` is 0.
  - `pool_adapter_retirement_skips_a_row_another_transaction_holds`: seed two expired sessions
    without connections; in a raw `sqlx::PgPool` transaction lock one with
    `SELECT … FROM pool_adapter.stratum_sessions WHERE session_id = $1 FOR UPDATE`; then
    `tokio::time::timeout(2 s, retention.retire(..))` returns `Ok(Ok(counts))` with
    `counts.sessions == 1`; after the lock's rollback a second `retire` deletes the other.
- [ ] **Step 2: Run** `cargo test --test stratum_v1_proxy retention`. Expected: compile failure
  on `count_expired` / `retire_until_done`; once stubbed, the lock test times out.
- [ ] **Step 3: Implement** the interfaces above, and add `FOR UPDATE OF connection SKIP LOCKED`,
  `FOR UPDATE OF session SKIP LOCKED` and `FOR UPDATE SKIP LOCKED` to the three `eligible` CTEs.
- [ ] **Step 4: Run** the same command. Expected: PASS, including the existing retention test.

### Task 2: The opt-in sweep in the Pool Adapter process

**Files:**
- Create: `src/stratum_v1/retention_sweep.rs` (settings and the sweep task)
- Modify: `src/stratum_v1.rs` (module and exports), `src/stratum_v1/process.rs`
  (`PoolAdapterConfig`, spawn), `src/bin/pool-adapter.rs` (read the environment)
- Test: unit tests in `src/stratum_v1/retention_sweep.rs`; process tests in
  `tests/stratum_v1_proxy/adapter_retention.rs` (new module in `tests/stratum_v1_proxy.rs`),
  with `AdapterLaunch::start_with(&self, extra_env: &[(&str, &str)])` added in
  `adapter_process.rs` and `start` calling it with `&[]`.

**Interfaces:**
- Consumes: `retire_until_done` from Task 1.
- Produces:
  - `pub enum PoolAdapterRetentionSweep { Off(SweepOffReason), On { interval: Duration,
    retention_seconds: u64 } }` and `pub enum SweepOffReason { IntervalUnset,
    DestructiveDisabled }`.
  - `PoolAdapterRetentionSweep::from_settings(maybe_interval: Option<&str>,
    maybe_retention: Option<&str>, destructive_enabled: bool)
    -> Result<Self, StratumV1Error>`. Every value that is set is validated, whatever the switch:
    a non-integer, an interval outside 60..=86,400, or a period under the floor is
    `Err(StratumV1Error::InvalidRetentionPolicy)`. Interval unset gives `Off(IntervalUnset)`;
    set with the switch off gives `Off(DestructiveDisabled)`.
  - `PoolAdapterConfig` gains `pub retention_sweep: PoolAdapterRetentionSweep`.
    `spawn_pool_adapter` logs once (`info`) whether the sweep is on and why not, and when on
    spawns a task that every `interval` (first tick immediate) runs
    `retire_until_done(now, retention_seconds, 1_000)`, logging nonzero counts at `info` and a
    failure at `warn`, then waits for the next tick.
  - `pool-adapter` reads `BWG_POOL_ADAPTER_RETENTION_INTERVAL_SECONDS`,
    `BWG_POOL_ADAPTER_RETENTION_SECONDS` and `BWG_GOVERNANCE_DESTRUCTIVE_ENABLED` (`== "true"`),
    and exits non-zero on a parse error before binding.

- [ ] **Step 1: Write the failing unit tests** for `from_settings`, one concern each: unset is
  `Off(IntervalUnset)`; `"60"` with the switch off is `Off(DestructiveDisabled)`; `"60"` and
  `"86400"` with the switch on are `On` with the floor as default period; `"59"`, `"86401"`,
  `"0"`, `"ten"` are errors; a period of floor − 1 is an error with the interval unset; a
  period of floor + 1 is carried through.
- [ ] **Step 2: Write the failing process tests** in `adapter_retention.rs`, seeding expired
  records as Task 1's helper does:
  - `adapter_sweep_deletes_expired_records_once_turned_on`: start with interval `"60"` and the
    switch `"true"`; within `WAIT_TIMEOUT`, polling `count_expired`, the count becomes empty.
  - `adapter_sweep_stays_off_without_the_destructive_switch`: start with interval `"60"` only;
    after the registry listens and 1 s more, the count is unchanged.
  - `adapter_refuses_to_start_on_an_invalid_retention_setting`: interval `"59"`; the child exits
    non-zero within `WAIT_TIMEOUT` (poll `try_wait`) and never listens.
- [ ] **Step 3: Run** `cargo test --lib retention_sweep` and
  `cargo test --test stratum_v1_proxy adapter_retention`. Expected: FAIL (types missing).
- [ ] **Step 4: Implement** the interfaces above.
- [ ] **Step 5: Run** both commands, then `cargo test --test stratum_v1_proxy`. Expected: PASS.

### Task 3: The `pool-adapter-governance` operator tool

**Files:**
- Create: `src/bin/pool-adapter-governance.rs` (thin `main`), `src/stratum_v1/governance_cli.rs`
  (the commands)
- Modify: `src/stratum_v1.rs` (module), `src/governance/cli.rs` (make `required_u64` and
  `optional_u64` `pub(crate)` for reuse)
- Test: `tests/governance_cli/pool_adapter.rs`, a new module in `tests/governance_cli.rs`

**Interfaces:**
- Consumes: `count_expired`, `retire_until_done`, `Serialize` on the counts (Task 1).
- Produces: `pub async fn run() -> Result<(), PoolAdapterGovernanceCliError>`:
  - `--help` lists `count-expired` and `delete-expired`.
  - `count-expired --as-of <s> [--retention-seconds <n>]` prints the counts as one JSON line.
  - `delete-expired --as-of <s> [--retention-seconds <n>] [--batch-size <1..1000>]
    --confirm-destruction` checks the switch and the flag first, then prints the totals as one
    JSON line. `--batch-size` defaults to 100.
  - `--retention-seconds` defaults to the floor; an unknown command, a missing option, a refused
    destruction or a policy error exits non-zero with a message naming no record.

- [ ] **Step 1: Write the failing tests**, each running
  `env!("CARGO_BIN_EXE_pool-adapter-governance")` with `env_clear()` plus what it needs:
  - `pool_adapter_cli_publishes_its_commands`: `--help` succeeds and names both commands.
  - `pool_adapter_count_changes_nothing`: after seeding, `count-expired` prints
    `{"connections":2,"sessions":1,"settled_events":1}` twice in a row.
  - `pool_adapter_delete_refuses_without_the_destructive_switch`: non-zero, and a following
    count is unchanged.
  - `pool_adapter_delete_refuses_without_confirmation`: switch on, no flag; non-zero, unchanged.
  - `pool_adapter_delete_removes_what_the_count_reported`: both safeguards, `--batch-size 1`;
    prints the same counts the count printed, and a following count is all zero.
  - `pool_adapter_cli_rejects_a_period_under_the_floor`: `--retention-seconds` floor − 1 on
    `count-expired` exits non-zero.
- [ ] **Step 2: Run** `cargo test --test governance_cli pool_adapter`. Expected: FAIL, the binary
  doesn't exist.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** the same command, then `cargo test --test governance_cli`. Expected: PASS.

### Task 4: The profile, the privacy page, and the record

**Files:**
- Modify: `docs/protocol/bwg-0.1-data-governance.md`, `reference/policies/privacy.html`,
  `scripts/policy-pages.test.ts`, the ticket, `map.md`

- [ ] **Step 1: Write the failing page test** in `scripts/policy-pages.test.ts`:
  `the privacy page states the Pool Adapter's schedule`: privacy contains
  `30 days after their session ends` and doesn't contain `aren't covered by that step`.
- [ ] **Step 2: Run** `bun test scripts/policy-pages.test.ts`. Expected: FAIL.
- [ ] **Step 3: Edit the privacy page.** A retention item: the Pool Adapter's miner logins,
  connection records and settled share records become eligible for deletion 30 days after their
  session ends or the share is settled. The closing paragraph: these take effect when the
  operator runs its retention steps or turns on the Pool Adapter's automatic deletion, with the
  marker `[Owner: state whether and how often you run retention, and whether the Pool Adapter's
  automatic deletion is on and how often it runs.]`. Check `operator.html` and `terms.html` for
  any sentence the change contradicts.
- [ ] **Step 4: Run** the page test. Expected: PASS.
- [ ] **Step 5: Edit the profile.** A matrix row: `Pool Adapter | Stratum session, connection
  reservation, and settled accepted-work record | Session expiry, or acknowledgement or refusal |
  Delete at day 30; no tombstone`. A subsection after the service-local CLI contract describing
  `pool-adapter-governance` (`count-expired`, `delete-expired`, its safeguards) and the sweep's two
  settings, stating that setting both the interval and `BWG_GOVERNANCE_DESTRUCTIVE_ENABLED=true`
  is the operator's standing confirmation, the one exception to per-run confirmation, and that
  the Pool Adapter has no manifest, audit event or export.
- [ ] **Step 6: Checks.** `cargo fmt --all`, `cargo clippy --all-targets --all-features -- -D
  warnings`, `cargo build --all-targets --all-features`, `cargo test --all-features`, `bun test`,
  `bun run typecheck`, `bun run check:standards`. Expected: all pass.
- [ ] **Step 7: Record.** Tick the ticket's Gate item, add a dated comment with what ran and the
  non-claims (no manifest/audit/export; the clock-ahead risk; the launcher leaves the sweep off),
  set Status `ready-for-human`, update `map.md`, and ask the owner before committing.
