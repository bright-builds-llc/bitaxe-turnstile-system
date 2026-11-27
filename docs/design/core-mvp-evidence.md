# BWG Core MVP: evidence and non-claims

This page says what the evidence for each [Core MVP success criterion](core-mvp-success-criteria.md) shows, and what it doesn't. It changes none of the protocol's guarantees, which stay as the protocol documents in `docs/protocol/` state them. The protocol's own non-claims and residual risks are in the [threat model](threat-model.md).

Hardware evidence comes from the C Reference Firmware on a Gamma 601 and an Ultra 205, recorded in the firmware repository's `docs/project/gate-integration-evidence.md`. Executable evidence is this repository's tests and the role profiles in `conformance/profiles.json`, which CI runs on every push.

## By criterion

| # | Shown | Not shown |
| --- | --- | --- |
| 1 | The reference Relying Service created each mainnet challenge from its account-creation Action Policy | — |
| 2 | A Claimant chose the Bitaxe Reference Client over USB, on both boards. On regtest, a Claimant chose "Use another Stratum V1 Worker" on the reference page, and a CPU miner configured from the settings it showed earned credit to a redeemed Gate Pass (`rehearse-production-path.sh --standard-worker`, [ADR-0114](../adr/0114-the-page-shows-a-standard-worker-its-lease-settings.md)) | A standard Stratum V1 Worker on mainnet, or a hardware miner other than a Bitaxe |
| 3 | On the 601, the signed package installed from stock and from a reference image, updated, and rolled back, with settings preserved and no account or app | A second board; a Migration Backup. The failed startup check that was recovered was staged |
| 4 | Consent named the connected board, its duration estimate and the criterion's fields before every Start | Several Workers in one consent: the MVP has one Worker per challenge |
| 5 | On the 601, every job the Pool Adapter relayed had an accepted Job Admission from pinned Hydra | That admission came before release, on hardware: that rests on the patch's tests and the regtest runner |
| 6 | Mainnet work went through the Pool Adapter to Hydra `v0.12.0` at `8eca024`, on both boards | — |
| 7 | Shares took Verified Progress to the Work Requirement on both boards | No double credit across an adapter restart, on hardware: that is a Rust test |
| 8 | For one Worker, reaching the requirement stopped the board and confirmed restoration, on both boards | Several Workers in one challenge, which is future work |
| 9 | Each mainnet pass redeemed once with a fresh DPoP proof, on both boards | — |
| 10 | On the 601, a spent pass couldn't be refreshed or redeemed again, and the action ran once | Execution after a service restart, a pass taken to another device, and a retry after expiry, on hardware: those are Rust tests |
| 11 | Pause, Cancel, expiry, tab close, a USB drop, a power pull, a pool failure, withheld and expired grants, and a handover between boards each failed safely | Malformed payout and invalid proposal on the C image, by the owner's choice; adapter replay on hardware |
| 12 | Each role profile passes in CI, and a Conformance Statement certifies a whole profile against its published vectors | Another implementation's run: its statement is its own claim |
| 13 | No board value or Device Identity fingerprint reached the Authority. The payout destination appeared only in the pool selection, which the Authority passes to the Pool Adapter and stores as a commitment | The raw Device Identity key wasn't searched, only its fingerprint |

## Across criteria

- Most hardware cases ran once, and some on one board only.
- The standard Stratum V1 and Bitaxe paths meet the same accounting and Redemption checks in the regtest rehearsal. Each had real shares credited across two lease windows and a Renew, a lease that survived a new tip, one synthetic share to the requirement, one redemption with DPoP, and a replay refused. The real Bitaxe path also ran on mainnet. They differ after the requirement: a standard Worker mines on until its credentials expire, 56 s in the rehearsal, and those shares earn no credit.
- No block was found on mainnet, so independent block submission is shown only on regtest, by `scripts/verify-hydra-solo-integration.sh`.
- A self-hosted deployment (Ticket 24) ran on regtest through consent, real shares, a Renew and Cancel. It then ran on mainnet with the 601 and the 205, once each: the three negatives, and a journey through redemption and the spent-pass retry, all passing.
- What the Rust tests check beyond the language-neutral vectors holds for the reference implementation only.
- One governance test failure under parallel load is still unexplained.
