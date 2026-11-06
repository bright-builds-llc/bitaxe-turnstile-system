# First end-to-end Gate on the C Reference Firmware image

Status: ready-for-agent

ADR-0105 made `bitaxe-esp-miner-c` the Reference Firmware. Its image reached
Gate parity on the Gamma 601, but every C-image lease so far was signed outside
the Gate Authority, mined against a pool named directly in the grant, and was
driven by the firmware's harness or by this repository's conformance pages. No
C image has completed a Gate through the production browser path. This effort
plans that first run: the `bwg-core/component` web component on the headless
SDK, direct Web Serial, Authority Start and Renew, the Stratum V1 Pool Adapter in
front of pinned Hydra, Verified Progress to the Work Requirement, Mining Baseline
restoration, Gate Pass redemption, and the settings-preserving signed-manifest
onboarding that leads into it. It is a plan; no hardware runs until Ticket 07.

Rules carried from the firmware repository: only the owner signs, agents never
use the owner's private keys, and committed evidence names its board, commits,
image and ELF digests and non-claims, and holds no IPs, MACs, SSIDs,
credentials, pool users or endpoints. Security findings name topics only.

## Core MVP criteria against C-image evidence

Criteria are from `docs/design/core-mvp-success-criteria.md`. "Partial" means
the firmware's `docs/project/gate-integration-evidence.md` covers the device
side through a test authority, not the production path.

| # | Criterion | C-image evidence |
| --- | --- | --- |
| 1 | Relying Service creates the challenge | None |
| 2 | Claimant selects the Bitaxe Reference Client | None |
| 3 | Onboarding preserves settings, no account or app | None. Settings held unchanged through leases (`worker-preservation-v2`), but no onboarding ran |
| 4 | Work Consent disclosure | None |
| 5 | Reward outputs and BIP 23 acceptance before release | None |
| 6 | Work through the Pool Adapter to pinned Hydra | None |
| 7 | Accepted Work Events advance Verified Progress | None |
| 8 | Work Requirement ends leases and confirms restoration | Partial: `challenge_satisfied` restoration through the conformance page |
| 9 | Gate Pass redeems with fresh DPoP | None |
| 10 | Action executes once, pass can't be reused | None |
| 11 | Failure cases fail safely | Partial: expiry, Pause, Cancel, disconnect and reboot through the conformance page; none for adapter replay, malformed payout, invalid proposal or stale job |
| 12 | Conformance Profiles pass in CI | Not a firmware criterion; no Client profile run against a real board |
| 13 | Privacy across context boundaries | None through the production path |

## Gaps found while planning

- No Authority HTTP route returned a `WorkerLeaseGrant` on Start or Resume, or
  served Renew. Ticket 01 added the claimant Work Session routes (ADR-0106).
  Ticket 10 added claimant Pool Selection (ADR-0107) and Stratum session
  renewal.
- Onboarding has only a simulated `BitaxeOnboardingDevice`. The C image reports
  no settings-schema version, settings readability or A/B rollback facts, and its
  build leaves app rollback off. Tickets 02 to 04.
- The C image has no signed firmware package manifest. Ticket 05.

## Tickets

Dependency order: 01 and 10 are resolved; 02 and 11 start now; 03 and 04 follow 02; 05
follows 03 and 04; 06 follows 04 and 11; 07 follows 05 and 06; 08 follows 07; 09
follows 08.
See [map.md](map.md).
