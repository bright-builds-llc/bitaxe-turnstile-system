# 02: Plan retention through service-local operator CLIs

**What to build:** A Service-Local Operator can run either context's CLI to obtain a digest-bound Retention Job plan without changing governed domain records, and can only apply that exact bounded plan when destructive mode and explicit confirmation are present.

**Blocked by:** 01: Publish the governance contract and lifecycle model.

**Status:** resolved

- [x] Pure typed policy calculation rejects configuration below Retention Floors and produces independently verifiable eligibility reasons and actions.
- [x] Separate Gate Authority and Relying Service CLIs expose `plan-retention`, `apply-retention`, and `export` without adding remote HTTP administration.
- [x] Additive migrations persist context-local manifests, ordered plan items, job state, resumable cursors, future tombstones, and audit events; the planner discovers only replay rows whose authoritative expiry already supplies a safe terminal floor.
- [x] Planning never mutates governed records; apply is disabled by default and rejects missing confirmation, digest drift, stale policy, or the wrong context.
- [x] CLI-level tests prove dry-run and repeated apply behavior without using database rows as acceptance oracles.

## Answer

Added a shared pure Retention Policy planner behind separate Gate Authority and Relying Service
operator binaries. The first end-to-end record classes are replay-proof identities: plans expose
only grouped reasons/actions and a digest, while enabled and confirmed apply invocations delete them
in durable bounded batches. Process-level tests prove default fail-closed behavior, exact-digest and
context binding, cursor resume, dry-run preservation, and idempotent completion through CLI output.
Tickets 03 and 04 own the additive terminal-time columns and backfill evidence that must exist before
legacy Authority or Relying Service operational rows can enter this planner.
