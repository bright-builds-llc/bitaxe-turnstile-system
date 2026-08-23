# V1 Pool Integration

## Topology

```text
Worker ──Stratum V1──> Pool Adapter proxy ──Stratum V1──> pinned Hydra ──RPC/ZMQ──> Bitcoin Core
                             │
                             └──gRPC Accepted Work Events──> Gate Authority
```

The Pool Adapter is the public Stratum endpoint. Hydra is co-located behind it and runs in solo/direct-payout mode. The adapter and Gate Authority are MIT project components; Hydra and its P2Pool v2 dependencies retain their disclosed AGPL licenses.

## Adapter responsibilities

- Issue and authenticate challenge-scoped Work Sessions.
- Forward standard Stratum V1 traffic without changing Bitcoin jobs or submissions.
- Track the server-assigned target effective for each submission.
- Associate the opaque session with one Work Challenge.
- Forward submissions toward Hydra before performing non-critical gate work.
- On an accepted response, durably enqueue an idempotent Accepted Work Event before acknowledging the Worker.
- Reject duplicate or cross-session submissions and expire session credentials with the Work Lease.
- Stream durable events to the Gate Authority over authenticated gRPC with at-least-once delivery.

## Non-responsibilities

The adapter does not construct Bitcoin templates, own Reward Policy, issue Gate Passes, infer work from hashrate, or poll dashboards for accounting. Hydra remains replaceable by another standard Stratum engine through a separate adapter profile.

## Mainnet job admission gap

Pinned Hydra/P2Pool v0.12 contains a BIP 23 validation helper, but it is not wired into the template-release path and its current success semantics target an already-known duplicate rather than pre-work proposal acceptance. The reference deployment must not assume this safeguard exists.

Before any mainnet job reaches the Pool Adapter proxy, the pool path must assemble the exact candidate block represented by that job, verify its Reward Policy outputs independently, submit it to Bitcoin Core in BIP 23 proposal mode, and require the pre-work success response. Missing full-template data, unavailable proposal support, inconclusive responses, payout mismatch, or validation failure prevents job release.

The preferred fix is a generic upstreamable Hydra/P2Pool job-admission hook that performs proposal validation before `mining.notify`, without adding BWG concepts to pool internals. The proxy remains an observer and gate-event adapter; it does not reconstruct incomplete blocks from Stratum messages or delay network-valid block submission.
