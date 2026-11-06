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
- [ ] Owner: load the Work Lease Authority and Gate Pass keys into the
  deployment. Agents never see them.
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

