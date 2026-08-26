# 17: Integrate pinned Hydra in solo direct-payout mode

**What to build:** A real standard Worker traverses the Pool Adapter proxy and the exact pinned Hydra/P2Pool engine against deterministic Bitcoin Core, receiving correct jobs, direct-payout terms, variable difficulty, and durable gate progress.

**Blocked by:** 09: Prove persistent lifecycle recovery and data governance; 15: Accept standard Stratum V1 work through the transparent proxy; 16: Prove the Hydra/P2Pool job-admission seam.

**Status:** resolved

- [x] Hydra and P2Pool versions and licenses are pinned and exposed in deployment provenance.
- [x] Hydra remains out of process and contains no Protected Action or Gate Pass concepts.
- [x] A standard Worker receives valid deterministic jobs through the proxy and submits accepted work.
- [x] Accepted responses produce durable, deduplicated Gate Authority progress.
- [x] Solo/direct-payout coinbase allocation matches the selected Reward Policy.
- [x] Vardiff, reconnect, rejected shares, stale jobs, and engine restart have end-to-end evidence.
- [x] The proxy adds no avoidable delay to potential block submission.

## Answer

The deployment now pins P2Poolv2/Hydra `v0.12.0` at commit
`8eca024bde6c2de74620dce2f9cc7fb9a544c5c0` (`AGPL-3.0-or-later`) and Bitcoin Core
28.1 (`MIT`) by source URL and SHA-256 in a checked-in provenance manifest. Hydra remains a separate
process; an isolated, digest-pinned test patch supplies only deterministic regtest and accelerated
variable-difficulty behavior without adding BWG application concepts.

Pool-facing payout authorization is minted from the Gate Authority's retained
session/challenge/consent binding, while the Worker keeps opaque standard credentials. The proxy
independently verifies Hydra's exact assigned target, reconstructs the Bitcoin header with canonical
byte order, and persists only accepted target-qualified work. The real integration decodes Hydra's
coinbase and proves the selected payout receives the full 50 BTC regtest subsidy, with only the
zero-value witness commitment beside it.

`scripts/verify-hydra-solo-integration.sh` checksum-verifies and builds the exact external sources,
then runs the complete Worker → proxy → Hydra → Bitcoin Core journey before and after a Hydra
restart. Both passes prove live vardiff, accepted and duplicate work, durable deduplicated Authority
progress, clean-tip stale rejection, fresh reconnect extranonce space, consent/session mismatch
cleanup, and a network-target block reaching Core before a forced local outbox failure. Each run
writes detailed gitignored logs plus a concise evidence summary under
`artifacts/hydra-solo-integration/`. The pinned harness, full repository verifier, and independent
Standards and Spec reviews against `e5d390d` all pass with no remaining findings.
