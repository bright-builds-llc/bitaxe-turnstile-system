# 16: Admit only exact BIP 23-valid mainnet jobs

**What to build:** No mainnet job reaches a Worker until the exact candidate represented by that job has independently matched its Reward Policy and received the successful pre-work BIP 23 proposal response from Bitcoin Core.

**Blocked by:** 15: Integrate pinned Hydra in solo direct-payout mode.

**Status:** ready-for-agent

- [ ] The exact candidate block and payout outputs are available before notification.
- [ ] Independent validation checks the current previous block, target, commitments, transactions, coinbase allocation, and selected Reward Policy.
- [ ] Bitcoin Core proposal mode receives the exact candidate and the pre-work success response is interpreted correctly.
- [ ] Missing full-template data, unavailable validation, inconclusive response, stale tip, payout mismatch, or invalid proposal prevents job release.
- [ ] Validation latency and concurrency remain bounded and observable.
- [ ] Deterministic regression cases cover every fail-closed category.
- [ ] Bounded mainnet evidence records exact source, pins, policy, Bitcoin Core result, and cleanup without exposing secrets.
