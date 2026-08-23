# BWG Data-Governance Implementation Map

## Parent

This child effort resolves the remaining governance criteria in
[`bwg-core` Ticket 09](../bwg-core/issues/09-persistent-lifecycle.md) without renumbering the BWG Core
roadmap.

## Decisions so far

- Governance is host-local and context-specific; Claimant proofs never authorize operator actions.
- Hosted identifying retention is 30 days, followed by a Pseudonymized Tombstone through day 90.
- Eligibility logic may be shared, but manifests, jobs, cursors, transactions, audit, and recovery
  remain context-local.
- The disposable lifecycle prototype is preserved on
  `codex/prototype-bwg-data-governance-lifecycle` at
  `6a468d137d7cc7a4273bb00bdbe7266a1db68fcc`.
- [Ticket 02](./issues/02-retention-planner-cli.md) established separate service-local CLI seams,
  a shared typed policy core, digest-bound context-local plans, and bounded idempotent replay-proof
  cleanup with destructive mode disabled by default.
- [Ticket 03](./issues/03-gate-authority-retention.md) added authoritative challenge terminal-time
  projection, post-expiry Gate Pass byte retirement, atomic day-30 Authority aggregate
  pseudonymization, and day-90 tombstone deletion without disturbing active adapter acknowledgements.
- [Ticket 04](./issues/04-relying-service-retention.md) added pass-expiry and terminal-outcome floors,
  marker-specific and aggregate Relying Service tombstones, lookup-window-aware retirement, and
  preservation of account business records outside the BWG aggregate.
- [Ticket 05](./issues/05-export-governance-audit.md) added resumable frozen NDJSON snapshots,
  byte-bound integrity manifests, prohibited-data scans, metadata-only lifecycle audits, failure
  categories, and day-90 retirement for audit and redacted snapshot records.

## Delivery order

1. [Governance contract and lifecycle model](./issues/01-governance-contract.md)
2. [Retention planner and operator CLI seam](./issues/02-retention-planner-cli.md)
3. [Gate Authority retention](./issues/03-gate-authority-retention.md)
4. [Relying Service retention](./issues/04-relying-service-retention.md)
5. [Export and governance audit](./issues/05-export-governance-audit.md)
6. [Composed recovery and parent-ticket closure](./issues/06-composed-recovery.md)
