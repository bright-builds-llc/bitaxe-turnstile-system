# 24: Package a reproducible self-hosted reference deployment

**What to build:** A self-hoster can launch the complete reference BWG Core stack through one documented, reproducible path and receive the same public interfaces, trust controls, provenance, health signals, and safety behavior as the hosted deployment.

**Blocked by:** 04: Secure challenge issuance and publish Authority discovery; 09: Prove persistent lifecycle recovery and data governance; 13: Protect account creation with an accessible Web Component; 19: Submit block candidates independently of gate outages.

**Status:** ready-for-agent

- [x] One supported launch path starts Gate Authority, PostgreSQL, Pool Adapter, pinned Hydra/P2Pool, Bitcoin Core integration, reference service, and Web Component assets.
- [x] Configuration distinguishes public endpoints, private service links, trust roots, secrets, Pool Offers, Action Policies, and payout terms.
- [x] Startup fails visibly when required pins, migrations, keys, proposal validation, or dependencies are unavailable.
- [x] Authority discovery, source, version, commit, build, engine, and license provenance are visible.
- [x] Health and readiness distinguish application availability from valid mining-job readiness.
- [x] Backup, restore, upgrade, key rotation, shutdown, and recovery operations are documented and testable.
- [ ] The deployment passes the same public acceptance harness without self-host-specific protocol forks.

## Self-host proof — 2026-11-26

Design: [`docs/superpowers/specs/2026-11-26-self-hosted-reference-deployment-design.md`](../../../docs/superpowers/specs/2026-11-26-self-hosted-reference-deployment-design.md),
with its defaults chosen by the agent. Runbook: [`docs/operations/self-hosted-deployment.md`](../../../docs/operations/self-hosted-deployment.md).
`scripts/rehearse-self-host.sh` passed on regtest (macOS arm64) of the tree this change commits, on `7bdb99d`,
with generated test keys.

- **Launch path:** `scripts/self-host-gate.sh --config FILE` validated a `bwg-self-host/0.1` file,
  started pinned Bitcoin Core and Hydra, then the owner's launcher. That launcher starts PostgreSQL on
  a named volume, the Authority, Pool Adapter, Reference Relying Service and the front with the page.
- **Configuration:** refused a managed node on mainnet, an unknown field in `secrets`, a secrets
  directory inside the repository, and a non-HTTPS origin, each with exit 2 and the field's path.
- **Startup failures:** a launch whose pool accepted connections and never answered refused at its
  20 s readiness deadline (`miningJob: no_job`) and left no PostgreSQL running. The launch rehearsal
  covers keys, modes and the owner trust. A child that exits before its port opens now stops the
  launch with its log's tail.
- **Provenance:** `/provenance` and discovery named the build's commit; `/provenance` listed the
  regtest patch first and Bitcoin Core 31.1.
- **Health and readiness:** `/healthz` answered available; `/readyz` answered ready only with an
  admitted job from Hydra.
- **Journey, through the deployment's own page in headless Chrome:**
  - The claimant chose the standard Worker; consent named "Your Stratum V1 Worker".
  - A CPU miner configured from the shown settings had 39 shares accepted in 20 s, and the page
    renewed the lease once. Verified progress reached 38 expected hashes.
  - Cancel through the page: the Authority reported `cancelled`, the page withdrew the settings, and
    the Pool Adapter cut the miner off 61 s after Cancel. No Gate Pass was asked for.
- **Operations:**
  - A backup was taken while running, into an owner-only directory.
  - A restore into a new volume succeeded, and a second restore over it was refused.
  - A relaunch on the restored volume held the journey's challenge and was ready.
  - Shutdown left no container behind, and no private key, credential or database password appeared
    in any log.

Non-claims:

- Regtest only. No mainnet launch with an external node was run, and Linux and Intel Macs are
  non-goals.
- The journey doesn't reach the Work Requirement, so no Gate Pass was issued or redeemed on a
  self-hosted deployment. The rehearsal's synthetic share is isolated from launched deployments
  (`tests/rehearsal_isolation.rs`), and a regtest CPU miner earns about one hash per share against
  at least 2^43. Issuance and redemption with a standard Worker are
  `scripts/rehearse-production-path.sh --standard-worker`'s, on the same services and page.
- A failed migration wasn't injected. The first upgrade run went from `1eda7d5` to this change, which adds no migration. Later runs upgrade from `1eda7d5` across whatever migrations land after it.
- The Gate negatives harness wasn't run against the self-hosted deployment; the journey shares its
  tab recorder and page controls.

### Upgrade and key rotation — 2026-11-26

The proof gained both, and passed again on regtest.

- **Upgrade:** `1eda7d5` launched from a temporary clean worktree and created a challenge. This tree
  then launched on the same volume with every migration applied in each of the three databases
  (15, 4 and 7), and kept the challenge. `/provenance` named each build's commit.
- **Rotation, on the restored volume:**
  - a new Gate Pass key: the Authority published both keys and the page trusted both. With the old
    key dropped, only the new one was published;
  - a new Reference Relying Service credential created a challenge;
  - a new Work Lease key (`rotate --role lease`) was seeded and recorded at shutdown, and the old
    key's high-water mark was kept.
- No private value from the old or rotated keys appeared in any log.

The last item stays open, and it can't close in software. A self-hosted Gate Pass needs at least
2^43 credited hashes. A regtest CPU miner would take weeks to earn them, and the rehearsal's
synthetic share is kept away from launched deployments. Closing it takes a Bitaxe or another
hashing Worker on a self-hosted deployment, on mainnet or with real hashrate.

The owner approved the design on 2026-11-26 and chose how the item closes: the Gate negatives harness
run by `scripts/rehearse-self-host.sh` on regtest, and one mainnet journey on the owner's self-hosted
deployment with a Bitaxe, through Gate Pass redemption. The same review added links to Hydra's
AGPL source to `/provenance`. Neither is built yet.
