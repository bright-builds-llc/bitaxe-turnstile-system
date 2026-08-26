# 16: Prove the Hydra/P2Pool job-admission seam

**What to build:** Source-level and runnable evidence identifying the smallest generic Hydra/P2Pool extension that can validate the exact constructed candidate before `mining.notify`, without introducing BWG Protected Action concepts into the pool.

**Blocked by:** 15: Accept standard Stratum V1 work through the transparent proxy.

**Status:** resolved

- [x] The current pinned template-construction and notification path is traced to primary source.
- [x] The existing BIP 23 helper's callability and pre-work success semantics are demonstrated rather than assumed.
- [x] At least one runnable prototype proves access to the exact candidate block and Reward Policy outputs before notification.
- [x] The recommended hook keeps block submission independent of gate accounting.
- [x] The hook is generic enough to propose upstream without BWG application concepts.
- [x] Failure, latency, concurrency, stale-template, and rollback consequences are documented with evidence.
- [x] The answer is precise enough for the dependent Hydra integration and BIP 23 tickets to implement without reopening the seam decision.

## Answer

The investigated P2Poolv2 `v0.12.0` tag resolves to commit
`8eca024bde6c2de74620dce2f9cc7fb9a544c5c0`; the deployment does not yet hold that immutable SHA,
which Ticket 17 must correct. Primary-source tracing shows GBT enters `NotifyCmd`, payout accounting
produces `OutputPair` values, `PreparedNotifyParamsBuilder` constructs and splits the payout-bearing
coinbase, and the notifier immediately publishes the prepared aggregate before per-connection
`mining.notify` construction.

The selected seam is a generic asynchronous Job Admission port after exact per-connection variant
construction and before tracker/socket publication. Its candidate freezes Hydra's miner commitment,
nanosecond timestamp, assigned extranonce1, payout bytes, and template identity in a canonical full
block; outputs are derived from that block, while a closed profile describes only Worker mutations.
Only independent Reward Policy agreement and a JSON `null` proposal result create digest-bound
admission evidence. Every non-null response, missing input/capability, timeout, stale generation,
changed tip, or unavailable required port withholds the job; bounded latest-generation-wins
concurrency prevents late success from publishing stale work.

The existing helper is private, dead/unwired, and returns true only for `"duplicate"`, which proves
post-discovery rather than fresh pre-work acceptance. Against the exact upstream SHA, all three
helper tests and `test_build_notify_and_extract_outputs_integration` pass; a disposable null-response
test proves the current helper returns `Ok(false)` for the response BIP 23 and Bitcoin Core define as
success. The pushed prototype branch at `e797930` preserves a reproducible patch and one-command
runner against the exact upstream SHA. Its two new upstream tests use the real builder and JobTracker
to prove full candidate/output access before release, blocked admission creating no job, acceptance
releasing that same variant, and late success failing to publish a superseded generation. The earlier
HTML lab remains on the branch for guided failure/rollback exploration but is not the seam acceptance
evidence.

The port is expressed only in Mining Pool candidate/output/template terms and never enters the
network-target submit fast path. Failure, latency, concurrency, stale-template, rollback, source-pin,
license, `workid`, and downstream implementation consequences are recorded in
[`hydra-p2pool-job-admission.md`](../../../docs/research/hydra-p2pool-job-admission.md), the resolved
design is linked from `v1-pool-integration.md`, and ADR 0090 preserves the boundary decision.
The full repository verifier passes, and independent Standards and Spec reviews against `ef06a7f`
have no remaining findings.
