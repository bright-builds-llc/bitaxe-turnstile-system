# 19: Submit block candidates independently of gate outages

**What to build:** A network-valid block candidate reaches Bitcoin Core immediately through the Mining Pool path even when Gate Authority delivery, PostgreSQL, SSE, or the Relying Service is unavailable.

**Blocked by:** 18: Admit only exact BIP 23-valid mainnet jobs.

**Status:** resolved

- [x] Block qualification and submission occur on the Mining Pool's latency-critical path.
- [x] Gate event persistence, acknowledgement, and delivery occur outside that submission dependency.
- [x] Gate Authority, database, event-stream, and application outage scenarios do not prevent block submission.
- [x] Submission result and reward outcome remain separate from Gate Pass validity.
- [x] Stale, rejected, duplicate, and reorganized block outcomes have explicit behavior.
- [x] The same result receives only its assigned-target Credited Work rather than luck-based extra credit.
- [x] End-to-end evidence measures submission timing and records residual operational risk.

## Answer

The pinned P2Poolv2/Hydra `v0.12.0` integration now applies the independently checksummed block
submission patch at SHA-256 `e136ea458e793cfe02d052d16b9049a9ab71c618d8b8c6dd979a809f6b7c3d52`.
Network-qualified results reconstruct and submit the full block before pool accounting or any BWG
effect. Bitcoin Core results are bounded to accepted, duplicate, rejected, inconclusive, or
unavailable metadata, and the public server boundary makes the separately configured 1–60,000 ms
submission deadline unrepresentable outside that range.

The composed test proves the actual Reference Relying Service and Authority/SSE surfaces are down
and the PostgreSQL container is paused while Bitcoin Core accepts the winning block. The observer is
abort-on-drop across every early return and cancellation path. After invalidate/reconsider and
database recovery, a fresh claimant proof returns the identical pre-outage issued Gate Pass bytes,
while evidence retains the assigned-target-only credit policy and the explicit risk that an accepted
block may receive no BWG credit when its post-submit observer cannot persist.

The pinned runner executes exact-name regressions for every Core outcome, hanging-RPC timeout,
builder bounds, stale jobs, duplicate shares, and below-target rejection, then completes the journey
before and after Hydra restart. Evidence at
`artifacts/hydra-solo-integration/20260826T062442Z-74874` records two accepted submissions, two reorg
exercises, and a maximum measured submission latency of 105 ms. Independent Standards and Spec
reviews against `8d8619f` pass with no remaining findings.
