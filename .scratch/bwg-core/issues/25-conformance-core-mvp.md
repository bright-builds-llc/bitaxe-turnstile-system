# 25: Publish BWG/0.x Conformance Profiles and prove the Core MVP

**What to build:** Versioned executable Client, Gate Authority, Pool Adapter, and Relying Service Conformance Profiles plus one reproducible end-to-end evidence set demonstrate every BWG Core MVP success criterion.

**Blocked by:** 14: Require trusted-origin consent for Elevated work; 19: Submit block candidates independently of gate outages; 20: Aggregate Workers and fail over equivalent Pool Offers; 23: Prove Work Lease restoration on real Bitaxe hardware; 24: Package a reproducible self-hosted reference deployment.

**Status:** ready-for-agent

- [x] Each role profile names its exact BWG/0.x version and publishes one reproducible command.
- [ ] Positive and negative fixtures cover work arithmetic, lifecycle, signatures, DPoP, event replay, expiry, rewards, privacy, and failure behavior.
- [ ] Implementations can self-certify only the profiles they actually pass.
- [ ] The reference account-creation journey passes through the hosted and self-hosted public seams.
- [ ] Standard Stratum and real Bitaxe paths both satisfy the same Gate Authority accounting and Redemption semantics.
- [ ] Every Core MVP success criterion has linked executable or hardware evidence.
- [ ] Mainnet evidence includes exact job admission and independent block-submission behavior.
- [ ] Residual risks and non-claims are published without weakening the protocol's stated guarantees.

## C Reference Firmware evidence — 2026-11-15, updated 2026-11-26

Mapped by the C-image Gate effort's Ticket 09, and updated from its Tickets 28 and 32 to 34. The
criterion-by-criterion table is in
[`c-image-end-to-end-gate/spec.md`](../../c-image-end-to-end-gate/spec.md), "Core MVP criteria
against C-image evidence", and the physical evidence is in the C repository's
[`docs/project/gate-integration-evidence.md`](https://github.com/bright-builds-llc/bitaxe-esp-miner-c/blob/220d2dd/docs/project/gate-integration-evidence.md).
On the owner's reference image of the C firmware, the Gamma 601 and the Ultra 205 each completed a
mainnet Gate through the deployed account-creation page, the Pool Adapter and pinned Hydra, ending
in a redeemed Gate Pass. Criterion 11 is still partial, and criterion 12 isn't a firmware
criterion. The owner limited the MVP to one participating Worker per challenge (2026-11-26), which
criterion 8's evidence meets.

Against this ticket's items:

- **Every criterion has linked evidence:** each has a C-image entry. Criterion 11 is partial:
  malformed payout and invalid proposal weren't run on the C image, by the owner's choice
  (2026-11-22), and adapter replay is a Rust test.
- **Standard Stratum and real Bitaxe paths share accounting and Redemption:** the real Bitaxe path
  ran on the C image; no standard Stratum Worker ran beside it.
- **Mainnet job admission and independent block submission:** on the 601, each relayed job had an
  accepted Job Admission (Ticket 33). No block was found, so block submission isn't shown.

Non-claims carried from the C-image evidence:

- Malformed payout and invalid proposal weren't run on the C image. Adapter replay, execution after
  a Relying Service restart, a pass taken to another device and a retry after expiry rest on Rust
  tests.
- A board's own refusal of another identity's grant rests on host tests; on hardware each page
  refused it first.
- The privacy audit searched board values and Device Identity fingerprints, not the raw Device
  Identity key.
- Several Workers in one challenge is future work (`.scratch/bwg-multi-worker-challenge/spec.md`).
- Most hardware cases ran once, some on one board only.

## Comments

- 2026-11-26: `conformance/profiles.json` names the Client, Gate Authority, Pool Adapter and
  Relying Service profiles at BWG/0.1, with their protocol documents and checks, and
  `bun run conformance <role>` runs one (`scripts/conformance-profile.ts`). A test fails when a Rust
  test target belongs to no profile. `.github/workflows/verify.yml` runs `bun run verify` and each
  profile as its own step on every push and pull request. The checks run against this repository's
  reference implementation, so the self-certification item stays open: another implementation
  can't yet point a profile at itself. The Worker Controller profile is checked by the firmware
  against the `bwg-worker-*` fixtures. Lib unit tests run under `bun run verify`, not in a profile.
  The first run with every profile green was Actions run 45875331547, on branch `ci-conformance`.
- 2026-11-26: fixture coverage against the second item. Work arithmetic (`work-vectors.json`), signatures and DPoP (`crypto-vectors.json`, `lookup-proof-vectors.json`), event replay, expiry and failure behaviour (`accepted-work-refusal-vectors.json`) each have positive and negative cases. Lifecycle had none, so `lifecycle-vectors.json` now pairs every Work Challenge and Work Session state with every command, with the freshness and validity boundaries, checked by `tests/lifecycle_vectors.rs` in the Gate Authority and Pool Adapter profiles. For rewards, `pool-offer-terms-vectors.json` covers the Reward Policy and payout requirements: a fee change or a new beneficiary is a material change, and a pooled mode, a short or excess allocation, a revenue claim, a custodial balance, an optional payout choice or one persisted by default is refused. It covers privacy only for that persistence rule. The payout commitment and the fields an issuance refuses have no fixture: the commitment is bound to a random challenge ID and computed inside the crate, and the refusals are Rust tests through HTTP. So the item stays open on privacy.
