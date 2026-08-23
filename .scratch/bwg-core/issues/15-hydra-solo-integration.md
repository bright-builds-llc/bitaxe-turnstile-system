# 15: Integrate pinned Hydra in solo direct-payout mode

**What to build:** A real standard Worker traverses the Pool Adapter proxy and the exact pinned Hydra/P2Pool engine against deterministic Bitcoin Core, receiving correct jobs, direct-payout terms, variable difficulty, and durable gate progress.

**Blocked by:** 07: Persist and recover the gate lifecycle; 13: Accept standard Stratum V1 work through the transparent proxy; 14: Prove the Hydra/P2Pool job-admission seam.

**Status:** ready-for-agent

- [ ] Hydra and P2Pool versions and licenses are pinned and exposed in deployment provenance.
- [ ] Hydra remains out of process and contains no Protected Action or Gate Pass concepts.
- [ ] A standard Worker receives valid deterministic jobs through the proxy and submits accepted work.
- [ ] Accepted responses produce durable, deduplicated Gate Authority progress.
- [ ] Solo/direct-payout coinbase allocation matches the selected Reward Policy.
- [ ] Vardiff, reconnect, rejected shares, stale jobs, and engine restart have end-to-end evidence.
- [ ] The proxy adds no avoidable delay to potential block submission.
