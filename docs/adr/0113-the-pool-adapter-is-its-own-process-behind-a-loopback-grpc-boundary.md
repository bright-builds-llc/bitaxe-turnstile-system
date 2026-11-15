# ADR-0113: The Pool Adapter is its own process behind a loopback gRPC boundary

Proposed 2026-11-15 by Ticket 16 of `.scratch/c-image-end-to-end-gate`, and accepted the same day
by the owner, unamended. It supersedes ADR-0109 and builds what
ADR-0055 and ADR-0022 called for. It changes no public route, Controller, deployment-trust or Gate
Pass profile.

## Decision

The `pool-adapter` binary runs the Stratum V1 proxy in its per-session mode, accepted-work delivery
and the Pool Selection expiry sweep, with its own database, credential key and Worker-facing
endpoint. `gate-authority` no longer opens the adapter's database or holds its credential key, and
it refuses to start when given ADR-0109's adapter settings.

The contract is `proto/bwg/pool_adapter/v1/pool_adapter.proto`, with one unary service each way:

- The Authority serves `AcceptedWorkIngest`: delivery of one Accepted Work Event with its lease
  context, and a Worker disconnect. It hands each call to the in-process port, so a delivery over
  the wire is credited or refused exactly as it is in process.
- The Pool Adapter serves `StratumSessionRegistry`: issue and renew a lease's Stratum credentials,
  and record and release a claimant's raw Pool Selection. The Authority's Worker Stratum port
  calls it after starting a lease, as ADR-0106 and ADR-0107 planned.

A delivery refusal is a typed reason in the response body, with the reasons and order of
`accepted-work-refusal-vectors.json`, and the adapter's outbox records it as terminal. Any status
other than OK is an outage the outbox retries with ADR-0108's backoff, and so is a refusal reason
the adapter's build doesn't know, so a newer Authority never makes an older adapter drop work.

Every call carries a deployment channel token, a 256-bit base64url secret checked against an HMAC
verifier. Both processes bind and dial loopback addresses only, because the channel has no TLS yet.
The launcher generates a fresh token for each run and gives it only to the two processes.

## Considered options

- **A bidirectional stream from the adapter.** ADR-0022 mentions streaming work events. The outbox
  already gives durability, order and redelivery, and each event needs its own answer to settle its
  row, so unary calls map one to one onto the existing ports and keep a restart simple.
- **Mutual TLS.** It would let the processes run on different hosts. Today they share one host, so a
  loopback-only token is enough. TLS comes before any split across hosts.

## Consequences

- Restarting the adapter alone credits nothing twice: Ticket 27's test now kills the real process
  after the Authority credits and before the adapter hears the answer, then starts a new one.
- A live Stratum session ends with its process. Inside one process, dropping the adapter's tasks
  stopped the accept loop, delivery and the sweep, but not live sessions.
- The in-process port stays as the reference both wire adapters are tested against.
