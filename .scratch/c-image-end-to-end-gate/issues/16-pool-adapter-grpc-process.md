# Pool Adapter runs as its own process over gRPC

Type: task
Status: resolved
Blocked by: None

## Objective

ADR-0109 runs the Stratum V1 proxy, delivery and the expiry sweep in the
Authority's process for now. Build the separate Pool Adapter process and the
gRPC boundary that ADR-0055 and ADR-0022 call for.

## Plan

- [x] A Protobuf contract for accepted-work delivery, worker disconnects and the
  session registry, with typed refusals.
- [x] The adapter process: proxy accept loop, delivery and expiry sweep, with its
  own database.
- [x] Both the in-process port and the gRPC adapter pass
  `accepted-work-refusal-vectors.json`, and the claimant routes of ADR-0106 and
  ADR-0107 are unchanged.
- [x] The rehearsal (Ticket 06) runs against the separate process.
- [x] Ticket 27's restart test runs against the separate process, restarting
  only the adapter.

## Comments

## Answer

Built on branch `claude/ticket-16-pool-adapter-grpc`, to ADR-0113, which the
owner accepted on 2026-11-15. ADR-0109 is marked superseded by it. Public
routes, OpenAPI and the refusal vectors are unchanged. No hardware was used.

- Contract: `proto/bwg/pool_adapter/v1/pool_adapter.proto`. The Authority
  serves `AcceptedWorkIngest` (delivery and Worker disconnects), and the
  adapter serves `StratumSessionRegistry` (issue, renew, record and release a
  Pool Selection). A delivery refusal is a typed reason in vector order, and
  any non-OK status is an outage the outbox retries. A reason the adapter
  doesn't know is retried too. Every call carries a channel token, checked
  against an HMAC verifier, and both sides accept loopback addresses only.
  `build.rs` uses a vendored `protoc`.
- Process: `src/bin/pool-adapter.rs` runs the proxy, delivery and sweep
  (`stratum_v1::process`, renamed from `in_process`) with its own database,
  credential key and Worker endpoint. `gate-authority` serves ingest on
  `BWG_ACCEPTED_WORK_GRPC_LISTEN_ADDRESS` and reaches the registry at
  `BWG_POOL_ADAPTER_GRPC_URL`. It refuses to start with ADR-0109's adapter
  settings.
- Vectors: `tests/accepted_work_refusal_vectors.rs` checks that the wire enum
  follows the vectors in order, that each wire refusal is terminal at the
  adapter, and that an outage, an unreachable Authority, a wrong token and an
  unknown reason are all retried. `authority_delivery.rs` delivers through the
  real Authority both in process and over gRPC: credit, and a refusal recorded
  once and never delivered again.
- Claimant routes: the shared fixture's `leased_application` now reaches the
  registry over gRPC, so the ADR-0106 and ADR-0107 route tests (19, including
  the raw-payout scan of rows and logs) pass through the boundary. The
  in-process port keeps its own tests.
- Ticket 27: the test now starts the real `pool-adapter` binary. The Authority
  stays up. Its ingest kills the adapter process after the Authority credits
  the second event and before the adapter hears the answer. A new process on
  the same database delivers only the reclaimed event, once. It passed 20 of
  20 runs in a loop.
- Deployment: `scripts/launch-gate-deployment.sh` starts `pool-adapter` as its
  own process with its own redacted log and a fresh channel token per run.
  `scripts/rehearse-gate-deployment-launch.sh` passed on regtest. It now checks
  that the proxy runs in `pool-adapter` and that the Authority serves ingest.
  The rehearsal harness and `scripts/rehearse-production-path.sh` start the
  separate process too.
  The production-path rehearsal passed on regtest on 2026-11-15: a Renew went
  through the registry, 49 real shares and the synthetic one were acknowledged
  over the wire, one late share was refused `challenge_satisfied` and not
  retried, nothing was left pending, and redemption returned 200.

Non-claims: no mainnet Gate or board ran against the separate process. The
channel has no TLS, so the processes must share a host. Ticket 27's original
non-claim stands: a restart on hardware isn't shown.
- 2026-11-15: the owner accepted ADR-0113 and closed the ticket; on `main` as `cf21d19`.

### Rehearsal against the separate process — 2026-11-26

`scripts/rehearse-production-path.sh` starts the `pool-adapter` binary as its own process
(`start_binary pool-adapter`), with the Authority's ingest and the adapter's registry on separate
loopback gRPC ports. On 2026-11-26 it passed that way three times on regtest: the Bitaxe run, the
standard Worker run (`--standard-worker`) and `--negatives`. The self-hosted deployment
(bwg-core Ticket 24) runs the same three processes through the owner's launcher. Regtest only.
