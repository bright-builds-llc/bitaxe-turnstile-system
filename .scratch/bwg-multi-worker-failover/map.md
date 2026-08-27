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
- [Ticket 03](./issues/03-equivalent-offer-failover.md) added the authenticated replacement-offer
  seam: the Authority reloads prior consent, verifies the signed candidate, classifies exact terms,
  durably releases endpoint-only equivalence, and holds every material candidate pending without a
  Work Session for Trusted Consent Ticket 04.
- [`bwg-trusted-consent` Ticket 04](../bwg-trusted-consent/issues/04-material-change-bridge.md)
  now signs replacement-specific material requirements, recovers the Authority ceremony, and
  releases only the exact receipt-bound replacement session.
- [Ticket 04](./issues/04-composed-failover-closure.md) added a metadata-only, restart-safe Pool
  Adapter failover projection; preserved the nearest authenticated offer through successive Worker
  replacements; reserved pending candidate session identities against registration races; aligned
  active material ceremonies with the reason-aware lifecycle matrix; and proved one
  database/Authority/adapter restart journey through equivalent recovery, reconfirmation,
  concurrent threshold crossing, terminal session shutdown, and single issuance.

## Delivery order

1. [x] [Aggregate exact work across concurrent and successive sessions](./issues/01-multi-session-aggregation.md)
2. [x] [Replace failed Workers without durable device identity](./issues/02-worker-replacement.md)
3. [x] [Fail over only between materially equivalent Pool Offers](./issues/03-equivalent-offer-failover.md)
4. [x] [`bwg-trusted-consent` material-change bridge](../bwg-trusted-consent/issues/04-material-change-bridge.md)
5. [x] [Compose failover, reconfirmation, and parent closure](./issues/04-composed-failover-closure.md)
