# Relying-service governance test hides why an Apply run exited non-zero

Type: bug
Status: needs-info
Blocked by: None

## Objective

Found in Ticket 24's loops (see its Comments).
`governance::outcome_lookup_survives_marker_retirement_until_aggregate_retention_floor` in
`tests/relying_service_persistence/governance.rs` failed once in 200 runs (4 copies of the test
binary in parallel, `--test-threads=8`) at `assert!(aggregate_apply.status.success())`, line 136
on `main`. The earlier assertions passed, so the action ran and both plans produced the expected
manifests. The second `apply-retention` run of `reference-service-governance` exited non-zero.
The test collected that child's `Output` but never printed it, so the cause is unknown.

Make a failing governance child's output part of the failure, reproduce the failure under
parallel load, and fix its root cause.

## Plan

- [x] A failing `plan-retention` or `apply-retention` run reports its exit status, stdout and
  stderr. No assertion is removed or loosened.
- [x] Loop the test binary under parallel load to reproduce the failure.
- [x] Rule out causes in the Apply path and in the test environment.
- [ ] Fix the root cause. Blocked: no loop has reproduced the failure, so its error is unknown.

## Findings so far

`tests/relying_service_persistence/governance.rs` now reports the governance child's exit status,
stdout and stderr, through `describe_output`, when either Apply assertion fails, and through
`manifest_from` when a plan run fails. Before, a failed plan surfaced only as a JSON parse error
on its empty stdout. The binary's `main` prints the `GovernanceCliError` to stderr, so the next
failure names its cause. A deliberate fault (the test's PostgreSQL container paused around one run,
a temporary patch) gave the exact symptom with the new message. The assertion is at line 140 on
this branch, and at 148 in that build, which also carried Ticket 23's and 24's test changes:

```text
panicked at tests/relying_service_persistence/governance.rs:148:5:
governance exited with exit status: 1
stdout:
stderr: Error: Governance(Database(PoolTimedOut))
```

The original failure isn't that fault: its whole run took 7.74 s, and a pool timeout takes 30 s.

### Loops

Every loop used one prebuilt test binary with the new diagnostics. To keep Tickets 23's and 24's
races (not on `main` yet) out of the signal, each binary carried their test-only changes as a
temporary, uncommitted patch, as Ticket 24's measurements did.

| Run | Runs | This failure | Other failures |
| --- | --- | --- | --- |
| Whole binary, 4 copies, `--test-threads=8` (the original setup), 50 rounds | 200 | 0 | 0 |
| Whole binary, 8 copies, `--test-threads=4`, 60 rounds | 480 | 0 | 5: Docker `PortNotExposed` and `WaitContainer(StartupTimeout)` at container start (Ticket 18) |
| Governance test only, 12 copies, 6 CPU-bound `yes` processes, 50 rounds | 600 | 0 | 0 |
| **Total** | **1,280** | **0** | |

If the rate were Ticket 24's 1 in 200, 0 in 1,280 would happen about 0.2% of the time. The
failure needs a condition these loops didn't create.

### Ruled out

- **Data or clock dependence in the Apply path.** Planning (`plan_retention`,
  `reference_retention_candidates.sql`) and Apply (`apply_retention`,
  `pseudonymize_relying_aggregate`) read the same rows with the stored `as_of`. Apply reads no
  host clock, and nothing writes these rows between the aggregate plan and its Apply: the
  Reference Service starts no background task, and the outcome lookups commit before they
  respond. The assertion at line 133 passed, so the aggregate plan held only
  `relying_service_operational` items. With the pass marker already pseudonymized, its SQL floor
  and the Rust `relying_retention_floors` agree, so a `StaleRetentionPlan` from a floor mismatch
  can't happen. Postgres container time (`NOW()`) is only recorded in audit events, never
  compared.
- **Ephemeral port exhaustion.** About 1,400 `TIME_WAIT` sockets under the heaviest loop, against
  16,384 ephemeral ports.
- **A test listener shadowing Docker's published port.** Docker Desktop publishes container ports
  on `*:<port>` (IPv4), and `localhost` falls back to `127.0.0.1`. A listener bound to
  `127.0.0.1:<port>` with `SO_REUSEADDR`, as tokio binds, does take that port's connections from
  Docker (a scratch script showed it). But the kernel's port 0 allocation never handed out a
  Docker-held port (0 of 4,000 binds), and Docker never published on a port held on loopback (0 of
  12 containers against 3,000 held ports). It can't arise in these tests.
- **The governance binary being rebuilt mid-loop.** The test runs
  `target/debug/reference-service-governance` by path. Ticket 24's session ran no cargo command
  during the loop that failed (00:23:51 to 00:30:38 CST on 2026-11-11), so the binary didn't
  change under it.

### What's left

Not reproduced. Something made one Apply run exit non-zero within a few seconds, and nothing in
the Apply path depends on timing or randomness. A transient fault outside the code is
the likeliest class: a refused or reset connection through Docker Desktop's port forwarder, or
the process being killed. Ticket 18 recorded faults of that kind at container start. That's
inference, not evidence. The next failure will print the cause. Until then this ticket waits on
that output (`needs-info`); attach it here and fix the cause it names.

Checks: `cargo fmt --all`, `cargo clippy --all-targets --all-features -- -D warnings`,
`cargo build --all-targets --all-features`, `cargo test --all-features` and `bun run check:standards`.

Environment note: about 50 `postgres:16-alpine` containers from 2 to 4 days ago were still running
on the Docker host during these loops, apparently leaked by earlier test runs. They weren't
removed here.

## Comments
