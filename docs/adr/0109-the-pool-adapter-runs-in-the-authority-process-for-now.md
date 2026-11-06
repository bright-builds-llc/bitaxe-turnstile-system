# ADR-0109: The Pool Adapter runs in the Authority's process for now

Accepted 2026-11-06, on the owner's choice for `c-image-end-to-end-gate`
Ticket 06. It defers part of ADR-0055 and ADR-0022, and changes no public route.

ADR-0055 runs the Pool Adapter as its own process, and ADR-0022 puts the
Authority-to-Pool Adapter boundary on gRPC. Neither is built yet. Until it is,
the production-path rehearsal (Ticket 06) and the first Gate on the C image
(Ticket 07) compose the Stratum V1 proxy in its per-session mode, accepted-work
delivery and the Pool Selection expiry sweep in the Authority's process. Delivery
goes through the in-process port, with ADR-0108's refusal and backoff rules. The
adapter keeps its own database and migrations, as it does today.

When the separate process and its gRPC boundary arrive, these must not change:

- the reason codes, terminal flags and backoff in
  [`accepted-work-refusal-vectors.json`](../../conformance/bwg-0.1/accepted-work-refusal-vectors.json);
- the claimant Work Session and Pool Selection routes of ADR-0106 and ADR-0107.

A browser or Worker sees no difference between the two deployments.
