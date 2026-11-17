# The Pool Adapter's expired records are never deleted

Type: task
Status: ready-for-human
Blocked by: None

## Objective

`src/stratum_v1/retention.rs` deletes the Pool Adapter's expired session,
connection and settled share records, with a 30-day floor and a test, but no
binary calls it. The data-governance profile's retention matrix has no Pool
Adapter row, and Ticket 19's privacy page has to say the Pool Adapter's
records aren't covered by the retention step. The raw payout address isn't in
scope: the Pool Selection sweep already deletes it when its challenge ends.

## Plan

- [x] Owner (2026-11-16): both an operator command and a configurable timer,
  the timer off unless turned on.
- [x] Gate: build both on the existing `retire`, record the Pool Adapter's row
  in the profile, and let the privacy page state the schedule.

## Design (approved by the owner 2026-11-16)

**Why.** So the privacy page can give one schedule for every service's
records, rather than leave the Pool Adapter's out.

**Approaches.** An operator command alone matches the other two services but
deletes nothing until the operator runs it. A timer alone gives a firmer
promise but deletes with no confirmation per run. A Pool Adapter context in
the full governance machinery (manifests, digests, audit, export) would give
exact parity but changes the shared governance core, which is out of scope.
The owner chose both the command and the timer.

**Goals.**
- A count of expired records that deletes nothing, beside the existing
  `retire`.
- `pool-adapter-governance`, reading only `BWG_POOL_ADAPTER_DATABASE_URL`:
  - `count-expired --as-of <unix-seconds> [--retention-seconds <n>]` prints
    the counts per table as JSON and changes nothing.
  - `delete-expired --as-of <unix-seconds> [--retention-seconds <n>]
    [--batch-size <1..1000>] --confirm-destruction` requires
    `BWG_GOVERNANCE_DESTRUCTIVE_ENABLED=true`, runs batches until one deletes
    nothing, and prints the totals.
- A sweep task in the Pool Adapter process, beside the Pool Selection sweep:
  - `BWG_POOL_ADAPTER_RETENTION_INTERVAL_SECONDS` (60 to 86,400) turns it on.
    Unset, it's off.
  - It runs only while `BWG_GOVERNANCE_DESTRUCTIVE_ENABLED=true` too, so one
    switch stops all deletion. The interval set without the switch, or the
    switch without the interval, leaves it off and logs that once at start.
  - `BWG_POOL_ADAPTER_RETENTION_SECONDS` defaults to 30 days and can't be
    lower. An invalid value stops the process at start.
  - Each run deletes in batches until one deletes nothing, logs the counts,
    and on failure logs a short error category and waits for the next run.
- Overlapping runs (the command during a sweep) skip rows the other has locked
  rather than wait on them.
- The profile gains a Pool Adapter row (sessions, connections and settled
  share records, deleted at day 30, no tombstone) and a sentence that its
  timer, once both settings are on, is the operator's standing confirmation.
- The privacy page says the Pool Adapter's records are deleted 30 days after
  they end, by the operator or automatically, with the `[Owner: …]` marker
  narrowed to whether the timer is on and how often it runs.

**Non-goals.** Manifests, digests, audit events or export for the Pool
Adapter; pseudonymized tombstones; changes to the Pool Selection sweep or to
the other two governance binaries.

**Anti-goals.** Deleting an unsettled share record, which delivery still
needs. Deleting anything with the destructive switch off. Logging any record
identifier, credential or payout data.

**Constraints.** The 30-day floor stays `HOSTED_OPERATIONAL_RETENTION_SECONDS`.
The timer uses the server's clock, so a clock set ahead deletes early, as the
Pool Selection sweep already would; noted, not guarded.

**Left to the builder.** Where the settings are parsed, the count's query
shape, and how the sweep's tests shorten the interval.

## Comments

- 2026-11-17, built to the design and `plan-31.md`, committed to `main` on the owner's word.
  `src/stratum_v1/retention.rs` gains
  `count_expired`, `retire_until_done` and `SKIP LOCKED` on its three batches;
  `src/stratum_v1/retention_sweep.rs` decides and runs the opt-in sweep, wired in
  `src/stratum_v1/process.rs` and `src/bin/pool-adapter.rs`; `pool-adapter-governance`
  (`src/stratum_v1/governance_cli.rs`) has `count-expired` and `delete-expired`, refusing any
  argument it doesn't know. Tests: `tests/stratum_v1_proxy/retention.rs` (count against a full
  run, unsettled records kept, a held session, connection and share record each skipped, each
  shown red with its clause removed), `adapter_retention.rs` (the real binary deletes at start
  with both settings, stays off without the switch, exits on an interval of 59),
  `pool_adapter_governance.rs` (seven cases), six unit tests of the settings, and a privacy page
  test. `cargo fmt`, `clippy -D warnings`, `cargo test --all-features` (480 pass), `bun test`
  (1445 pass), `bun run typecheck` and `bun run check:standards` pass. A fresh reviewer found no
  critical issue; a misspelled `delete-expired` option, lock skipping pinned for sessions only,
  and four sentences broader than the code were fixed, each with a test. Non-claims: the Pool
  Adapter has no manifest, audit event or export; a clock set ahead deletes early; the launcher
  leaves the sweep off; the sweep scans whole tables (no index on session expiry), unmeasured;
  the privacy page is still a draft awaiting the owner.
