# BWG Multi-Worker Failover Implementation Map

## Parent

This child effort resolves
[`bwg-core` Ticket 20](../bwg-core/issues/20-multi-worker-pool-failover.md) without renumbering the
BWG Core roadmap. Its material-change seam composes with
[`bwg-trusted-consent` Ticket 04](../bwg-trusted-consent/issues/04-material-change-bridge.md).

## Decisions so far

- The Work Challenge owns exact cumulative progress; individual Work Sessions remain replaceable
  contributors.
- Replacement uses fresh session-scoped operational identity and never requires a durable Worker or
  Device Identity.
- Automatic failover is limited to Authority-authenticated, materially equivalent Pool Offers.
- Material replacements remain pending and release no work until Trusted Consent Ticket 04 binds a
  fresh receipt to the changed signed terms.
- Parent Tickets 14 and 20 close only after the final composed proof; neither parent is a prerequisite
  of its own child implementation.
- [Ticket 01](./issues/01-multi-session-aggregation.md) confirmed the existing PostgreSQL Authority
  transaction is already challenge-scoped across concurrent and successive Work Sessions: distinct
  exact contributions serialize on one progress row, global deduplication remains stable, failed
  sessions cannot erase work, and threshold races create one recoverable issuance intent.
- [Ticket 02](./issues/02-worker-replacement.md) made terminal threshold handling stop ready as well
  as leased late replacements; added established-Stratum disconnect delivery; and persisted one
  idempotent, generation-fenced replacement transition with a derived reason, fresh lease/Stratum/
  extranonce identity, restart-safe progress, terminal admission rejection, and Relying-facing
  identity minimization.

## Delivery order

1. [x] [Aggregate exact work across concurrent and successive sessions](./issues/01-multi-session-aggregation.md)
2. [x] [Replace failed Workers without durable device identity](./issues/02-worker-replacement.md)
3. [Fail over only between materially equivalent Pool Offers](./issues/03-equivalent-offer-failover.md)
4. [`bwg-trusted-consent` material-change bridge](../bwg-trusted-consent/issues/04-material-change-bridge.md)
5. [Compose failover, reconfirmation, and parent closure](./issues/04-composed-failover-closure.md)
