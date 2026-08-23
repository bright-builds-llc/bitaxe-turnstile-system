# 14: Prove the Hydra/P2Pool job-admission seam

**What to build:** Source-level and runnable evidence identifying the smallest generic Hydra/P2Pool extension that can validate the exact constructed candidate before `mining.notify`, without introducing BWG Protected Action concepts into the pool.

**Blocked by:** 13: Accept standard Stratum V1 work through the transparent proxy.

**Status:** ready-for-agent

- [ ] The current pinned template-construction and notification path is traced to primary source.
- [ ] The existing BIP 23 helper's callability and pre-work success semantics are demonstrated rather than assumed.
- [ ] At least one runnable prototype proves access to the exact candidate block and Reward Policy outputs before notification.
- [ ] The recommended hook keeps block submission independent of gate accounting.
- [ ] The hook is generic enough to propose upstream without BWG application concepts.
- [ ] Failure, latency, concurrency, stale-template, and rollback consequences are documented with evidence.
- [ ] The answer is precise enough for the dependent Hydra integration and BIP 23 tickets to implement without reopening the seam decision.
