# PostgreSQL test container is used before it accepts queries

Type: bug
Status: resolved
Blocked by: None

## Objective

`tests/support/postgres.rs` stopped waiting at the first "database system is
ready to accept connections" line. The image also prints that line from its
temporary init server, before it restarts, so a test could connect too early.
`relying_service_persistence` failed once this way under `bun run verify` during
Ticket 12, with a protocol error at connect, and passed 3 of 3 runs alone.

## Plan

- [x] After the log line, wait until a real `SELECT 1` succeeds, within 30 s.
- [x] `relying_service_persistence` passes 5 of 5 runs, and the full suite passes.

## Answer

`PostgresTestDatabase::start` now polls a query every 250 ms after the log
line. The failure was intermittent, so no run reproduced it before or after;
the fix removes the window instead.

## Comments

- 2026-11-06: the first full-suite run with this fix had one failure, in
  `authority_persistence`. Docker reported `PortNotExposed` while mapping the
  container's port, before the new wait ran. The test passed 3 of 3 runs alone,
  and a full re-run passed 37 of 37. This is a separate one-off that the fix
  doesn't cover.
