# 24: Package a reproducible self-hosted reference deployment

**What to build:** A self-hoster can launch the complete reference BWG Core stack through one documented, reproducible path and receive the same public interfaces, trust controls, provenance, health signals, and safety behavior as the hosted deployment.

**Blocked by:** 04: Secure challenge issuance and publish Authority discovery; 09: Prove persistent lifecycle recovery and data governance; 13: Protect account creation with an accessible Web Component; 19: Submit block candidates independently of gate outages.

**Status:** resolved

- [x] One supported launch path starts Gate Authority, PostgreSQL, Pool Adapter, pinned Hydra/P2Pool, Bitcoin Core integration, reference service, and Web Component assets.
- [x] Configuration distinguishes public endpoints, private service links, trust roots, secrets, Pool Offers, Action Policies, and payout terms.
- [x] Startup fails visibly when required pins, migrations, keys, proposal validation, or dependencies are unavailable.
- [x] Authority discovery, source, version, commit, build, engine, and license provenance are visible.
- [x] Health and readiness distinguish application availability from valid mining-job readiness.
- [x] Backup, restore, upgrade, key rotation, shutdown, and recovery operations are documented and testable.
- [x] The deployment passes the same public acceptance harness without self-host-specific protocol forks.

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
AGPL source to `/provenance`.

- **Hydra's source, 2026-11-27:** `/provenance` now links Hydra's pinned upstream archive and each
  patch at the build's commit, with their SHA-256 digests. Unit-tested. On this tree the regtest
  document's digests matched the patch files, and a patch link at the pushed commit answered 200. The
  self-host rehearsal now checks the links, but it wasn't rerun for this change. A dirty build links
  its base commit, which its patches may not match; the digests show it.
- **Negatives harness, 2026-11-27:** against a launched deployment the harness has only its
  deployment adapter, which needs real boards and a person at each port chooser; the rehearsal's fake
  board is kept away from launched deployments. The owner moved it into the hardware session: on the
  mainnet self-hosted deployment, two Bitaxes run
  `--cases withheld,expired_context,handed_over,journey`, which also covers the journey through Gate
  Pass redemption. That session closes this item; nothing is left to build.

## Hardware session on the mainnet self-hosted deployment — 2026-11-27

The last item closes here. Every case passed, and the harness printed `negatives: passed`.

- **What ran:**
  - Gate: `a1c4697`, clean and pushed, with build time `2026-11-27T09:19:30Z`. `/provenance` and discovery both named that commit.
  - Launch: `scripts/self-host-gate.sh --config FILE` on macOS arm64, from a private `bwg-self-host/0.1` file. It used the `tailscale` origin, a new PostgreSQL volume and the Work Requirement 2^45 (`payoutTerms.expectedHashes`).
  - Node and engine: Hydra (p2poolv2 0.12.0 at `8eca024`, with the job-admission and block-submission patches) on the owner's synced mainnet node (Bitcoin Core 31.1). It was reached by the external-node path, with the node's RPC and ZMQ forwarded to loopback.
  - Boards: the Gamma 601 and the Ultra 205, both on the owner's reference image of `247d2cd`, the same image digests as Tickets 32 and 34.
  - Harness: `scripts/gate-negatives-harness.ts` with its deployment adapter, unchanged, run once with `--cases withheld,expired_context,handed_over,journey`. Chrome was started through `open -na` with a new profile, and the owner picked each port.
- **Timing:** launched at about 09:31 UTC. Checked just after launch, `/healthz` answered available and `/readyz` `admitted_job`; readiness wasn't watched between then and the sitting. The harness ran 16:39 to 16:44 UTC, and the launcher stopped at 16:45 UTC, exiting 0.
- **Provenance:** Hydra's upstream archive and both patch links at `a1c4697` answered 200, and each file's SHA-256 matched the document. The mainnet document lists the two mainnet patches and no regtest patch.
- **`withheld` and `expired_context`, on the 205:**
  - Each consent named "Bitaxe Ultra 205" alone, estimating 70.4 s.
  - `withheld` held its Start grant; `expired_context` held its grant 65 s, past the board's 60 s unused context.
  - Each challenge ended `cancelled` with Verified Progress 0 and no Gate Pass request.
- **`handed_over`, with tab a the 601 and tab b the 205 in its own browser context:**
  - Each consent named only its tab's board.
  - Both challenges ended `cancelled` with Verified Progress 0 and no Gate Pass request.
  - Neither board logged a lease in any negative.
- **`journey`, on the 601:**
  - The consent named "Bitaxe Gamma 601" alone, estimating 29.3 s.
  - Every grant passed through, and the audit searched 6 Renew grants.
  - The Authority reached `satisfied`, then `pass_issued`, with Verified Progress just over 2^45. The redemption was answered 200.
  - The spent-pass retry refreshed the identical pass, and its second redemption was refused with 401 `invalid_redemption`.
  - The board logged one lease, stopped on restoration and logged `Lease stop finished ok=1`.
- **Every case:**
  - The audit searched the 8 board values and each tab's Device Identity fingerprints and found no violation.
  - The only board-derived field sent to the Authority was `control_session_binding_sha256`. The payout address appeared only in the pool selection.
  - The Authority holds exactly the five challenges the cases used. No stale job was logged.
  - Both boards ended paused with `mineOnBoot` 0.
  - No payout address, LAN address or origin appeared in the harness's or the services' logs.
- **Same harness, no fork:** the deployment ran the same front, page, launcher and harness as Tickets 28 and 32. No route, field or behaviour was added or changed for it.

Non-claims:

- One run of each case, on one image and two boards. macOS arm64 and the Tailscale origin only; a self-hoster's own TLS proxy wasn't used.
- The Work Requirement was the 2^45 override, not the Standard policy's default.
- The Gate keys were copied from Ticket 07's directory, and the Work Lease Authority is the owner's development authority. A self-hoster's freshly generated keys weren't used on hardware.
- The deployment adapter observes no board directly, so the board's own `admission_required` refusal in `expired_context` wasn't seen; the 205 logged no lease. A handed-over grant is refused by the page, not the board, as in Ticket 32.
- The Device Identity was searched as its fingerprint, not its raw key.
- No block was found, so block submission on a self-hosted deployment isn't shown here.
- The private records are kept outside the repository.

