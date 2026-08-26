# BWG/0.1 Independent Block Submission

A Worker result that meets the Bitcoin network target takes the Mining Pool's direct submit path.
Hydra reconstructs the full block and calls Bitcoin Core before pool-difficulty accounting, share
emission, Pool Adapter persistence, Accepted Work acknowledgement, Gate Authority delivery, SSE,
Gate Pass issuance, or any Relying Service operation. No BWG service is imported into that path.

## Outcome separation

Bitcoin Core `submitblock` outcomes are explicit metadata-only values:

- JSON `null` is `accepted`;
- `duplicate` is `duplicate`;
- `duplicate-inconclusive` or `inconclusive` is `inconclusive`;
- `duplicate-invalid` and every other rejection string are `rejected`; and
- transport, HTTP, RPC, or parsing failure is `unavailable`.

Hydra bounds `submitblock` with the independently configured `block_submission_timeout_ms`
deadline. Both raw configuration and the public server-builder type reject values outside 1–60,000
milliseconds. Hydra records block hash, category, and submission latency without logging credentials
or payout identity. A timeout is `unavailable`; it never falls back through a gate service. These
reward-path outcomes do not change the Stratum share response or BWG accounting.
The Gate Authority always derives Credited Work only from the job's assigned target; meeting the
network target never creates luck-based extra credit. Conversely, a Core rejection or later reorg
does not subtract previously accepted target-qualified work and cannot revoke an issued Gate Pass.

Stale tracker jobs are unavailable after a new tip, exact duplicate shares are rejected before
resubmission, and below-target/rejected shares never reach `submitblock`. A duplicate block response
is observable but does not cause a retry through gate services. Reorganization is a Bitcoin reward
outcome only.

## Composed outage evidence

Run:

```bash
scripts/verify-hydra-solo-integration.sh
```

For each pre/post-Hydra-restart journey, the harness:

1. proves the actual Reference Relying Service can issue its Standard challenge, then establishes a
   deterministic Light challenge for BIP 23 admission, accepted shares, durable Authority progress,
   and an issued Gate Pass snapshot; one separately identified below-network-target fixture event
   satisfies the Light issuance precondition so the later network-winning result remains a distinct
   reward-path outcome;
2. aborts the actual Reference Relying Service, then the Gate Authority HTTP server and SSE surface;
3. reconnects the Worker and receives a fresh admitted job;
4. pauses the actual PostgreSQL container after session authorization;
5. submits a network-target result and measures Bitcoin Core height advancement before waiting on
   the unavailable Pool Adapter observer;
6. aborts the stalled observer after a bounded two-second diagnostic window;
7. invalidates and reconsiders the accepted block to exercise a deterministic reorg; and
8. resumes PostgreSQL, performs a fresh claimant-authenticated issuance lookup, and confirms the
   Gate Pass status and exact signed bytes are unchanged from before the rejection/reorg exercise.

The runner also executes exact-name upstream regressions for accepted, duplicate, rejected,
inconclusive, unavailable, hanging-RPC timeout, stale-job, duplicate-share, and below-pool-target
behavior. Evidence files record timing, Core result, outage matrix, reorg, Gate Pass continuity,
assigned-target-only credit policy, exact source and patch pins, and cleanup. Logs are
prohibited-value scanned and all temporary credential-bearing state is deleted on success or
failure.

The main residual risk is explicit: if the Pool Adapter database is unavailable after Core accepts a
block, that winning share may receive no BWG credit because the Worker cannot receive a durable
accepted acknowledgement. The direct coinbase reward remains safe, and the system never invents
credit from an unpersisted observation.
