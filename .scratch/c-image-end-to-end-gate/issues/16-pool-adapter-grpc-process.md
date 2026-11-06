# Pool Adapter runs as its own process over gRPC

Type: task
Status: ready-for-agent
Blocked by: None

## Objective

ADR-0109 runs the Stratum V1 proxy, delivery and the expiry sweep in the
Authority's process for now. Build the separate Pool Adapter process and the
gRPC boundary that ADR-0055 and ADR-0022 call for.

## Plan

- [ ] A Protobuf contract for accepted-work delivery, worker disconnects and the
  session registry, with typed refusals.
- [ ] The adapter process: proxy accept loop, delivery and expiry sweep, with its
  own database.
- [ ] Both the in-process port and the gRPC adapter pass
  `accepted-work-refusal-vectors.json`, and the claimant routes of ADR-0106 and
  ADR-0107 are unchanged.
- [ ] The rehearsal (Ticket 06) runs against the separate process.

## Comments
