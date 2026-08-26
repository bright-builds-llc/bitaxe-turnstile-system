# 18: Admit only exact BIP 23-valid mainnet jobs

**What to build:** No mainnet job reaches a Worker until the exact candidate represented by that job has independently matched its Reward Policy and received the successful pre-work BIP 23 proposal response from Bitcoin Core.

**Blocked by:** 17: Integrate pinned Hydra in solo direct-payout mode.

**Status:** resolved

- [x] The exact candidate block and payout outputs are available before notification.
- [x] Independent validation checks the current previous block, target, commitments, transactions, coinbase allocation, and selected Reward Policy.
- [x] Bitcoin Core proposal mode receives the exact candidate and the pre-work success response is interpreted correctly.
- [x] Missing full-template data, unavailable validation, inconclusive response, stale tip, payout mismatch, or invalid proposal prevents job release.
- [x] Validation latency and concurrency remain bounded and observable.
- [x] Deterministic regression cases cover every fail-closed category.
- [x] Bounded mainnet evidence records exact source, pins, policy, Bitcoin Core result, and cleanup without exposing secrets.

## Answer

The deployment provenance now pins a production Job Admission patch for P2Poolv2/Hydra `v0.12.0`
commit `8eca024bde6c2de74620dce2f9cc7fb9a544c5c0` at SHA-256
`3f9c286337ccf16e39e8dd989833dd96f5a7cb94118d83361427a394d1b2b59f`. Mainnet
requires this gate regardless of the compatibility setting; the deterministic regtest profile opts
into the identical path.

Each connection constructs a canonical unadmitted block after fixing all pool-owned coinbase and
template bytes. Independent validation compares previous block, expanded target, ordered txid/wtxid
sets, merkle root, exact template witness commitment, optional bounded `workid`, and the zero-fee
solo-direct payout allocation. The exact serialized candidate and `workid` go to Bitcoin Core BIP 23
proposal mode, where only JSON `null` admits the job. A receipt digest binds the block, generation,
and closed Worker-mutation profile.

Proposal queueing/RPC is limited by configured 1–60,000 ms deadlines and 1–1,024 shared slots, with
the deepest constructor enforcing the same bounds. A per-server generation gate serializes template
publication with the final stale check, tracker insert, and socket release. Release is capped at 250
ms; partial or failed writes roll back the exact tracker job, release the gate, and disconnect. New
tips invalidate old tracker state and require reconnect, while the network-block submit fast path
remains independent.

The pinned runner executes exact-name fail-closed upstream regressions and asserts one test ran for
each, then completes the real Worker → proxy → Hydra → Bitcoin Core journey before and after Hydra
restart. The final evidence records six actual JSON-null admissions plus source, policy, patch,
latency, Core version, restart, block path, and cleanup. RPC credentials are random and ephemeral;
logs are prohibited-value scanned, and the entire temporary tree is deleted on every exit.
Independent Standards and Spec reviews against `430e209` pass with no remaining findings.
