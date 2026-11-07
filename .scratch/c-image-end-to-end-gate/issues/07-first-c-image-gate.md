# First end-to-end Gate on the C image

Type: task
Status: ready-for-human
Blocked by: 06

## Objective

Run one complete Gate on a real board through Ticket 06's page and services,
with the owner at the board. The Gamma 601 goes first, flashed by hand with the C
reference image, as the board the owner's image was admitted on; the Ultra 205
follows. Onboarding is not part of this run (Ticket 15).

Follow [run-sheet-07.md](../run-sheet-07.md).

## Plan

- [ ] Owner: choose the network for the run. Criterion 5 needs mainnet with
  per-job BIP 23 admission (Core Ticket 18).
- [x] Owner: choose the origin. A Tailscale origin on this Mac, approved
  2026-11-07.
- [ ] Owner: generate the Gate's keys and launch the deployment with
  `scripts/launch-gate-deployment.sh`, which reads the Work Lease Authority and
  Gate Pass keys from the owner's files. Agents never see them.
- [ ] Gate: consent shown, Start, renewals, shares through the adapter credited as
  Verified Progress, the Work Requirement reached, restoration confirmed as
  `challenge_satisfied`, the Gate Pass redeemed once with DPoP and refused on reuse.
- [ ] Evidence: board, Gate and firmware commits, image and ELF digests, timings,
  non-claims, and nothing private, recorded in both repositories.

## Comments

- 2026-11-06: the owner chose mainnet. Neither pinned Hydra nor job admission
  needs `-txindex`, and both work against a pruned node.
  - Hydra's source calls only `getblockchaininfo`, `getblocktemplate` (including
    the BIP 23 proposal), `getdifficulty`, `submitblock` and
    `decoderawtransaction`, and none reads the transaction index. Upstream's own
    signet and testnet4 node configs run `prune=1000` with `txindex` off.
  - On regtest, the upstream admission tests and the Hydra integration pass at
    `-prune=550` without txindex. They also pass after `pruneblockchain`
    deleted blocks 0 to 253. That one-off expected the halved regtest subsidy,
    because the chain was past height 600.
  - `scripts/hydra-mainnet-stack.sh` runs the node pruned, and refuses to start
    Hydra while the node is in initial block download. The run sheet gives the
    disk needs and sync time.
- 2026-11-06: the owner chose an existing synced mainnet node over a new pruned
  sync. It runs Bitcoin Core 31.1 with `txindex`, which is a deviation from the
  28.1 pin that the evidence must name.
  - `scripts/hydra-mainnet-stack.sh --external-node` downloads and starts no
    Bitcoin Core. It takes loopback RPC and ZMQ URLs (through the owner's SSH
    tunnel) and an owner-only credentials file outside the repository. It
    refuses to start Hydra unless the node reports chain `main` and has left
    initial block download.
  - Credentials reach curl on stdin and Hydra through its environment, never
    a command line, the config or a log.
  - `scripts/verify-hydra-solo-integration.sh --external-node` passes on
    regtest against a separately started node. The stack refused it six ways
    and left it running, and Hydra then passed the integration through the
    same path.
  - The pruned sync stays in the run sheet as the fallback.
- 2026-11-07: the launcher the run sheet assumed now exists, with the owner's
  approval and a Tailscale origin.
  - `scripts/gate-deployment-keys.ts` generates the Gate Pass signing key, the
    service credential and the Stratum credential key, mode 600, and prints only
    public values.
  - `scripts/launch-gate-deployment.sh` reads those keys and the existing Work
    Lease Authority from files at run time. It passes them only through each
    binary's environment, and checks the lease key against the owner trust.
  - It seeds the lease sequence above `lease-sequence.json` plus a margin, and
    fails closed if that file is unreadable. It records the run's high-water mark
    back at the end.
  - It binds the proxy to the LAN address and serves the filled page through
    `tailscale serve`. Its logs redact the address and the tailnet name.
  - `scripts/rehearse-gate-deployment-launch.sh` proves it on regtest with
    generated test keys. It doesn't use Tailscale or the board.
  - Hydra takes its payout from the pool user file
    (`--payout-from-pool-user`), so the address never goes on a command line.
  - The consent screen's policy links don't resolve yet; that is Ticket 19.
