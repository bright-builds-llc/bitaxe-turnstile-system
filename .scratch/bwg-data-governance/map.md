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
  `b0014ec353754e94e22b2c7031130bb61c37ee18`.

## Delivery order

1. [Governance contract and lifecycle model](./issues/01-governance-contract.md)
2. [Retention planner and operator CLI seam](./issues/02-retention-planner-cli.md)
3. [Gate Authority retention](./issues/03-gate-authority-retention.md)
4. [Relying Service retention](./issues/04-relying-service-retention.md)
5. [Export and governance audit](./issues/05-export-governance-audit.md)
6. [Composed recovery and parent-ticket closure](./issues/06-composed-recovery.md)
