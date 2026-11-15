# 25: Publish BWG/0.x Conformance Profiles and prove the Core MVP

**What to build:** Versioned executable Client, Gate Authority, Pool Adapter, and Relying Service Conformance Profiles plus one reproducible end-to-end evidence set demonstrate every BWG Core MVP success criterion.

**Blocked by:** 14: Require trusted-origin consent for Elevated work; 19: Submit block candidates independently of gate outages; 20: Aggregate Workers and fail over equivalent Pool Offers; 23: Prove Work Lease restoration on real Bitaxe hardware; 24: Package a reproducible self-hosted reference deployment.

**Status:** ready-for-agent

- [ ] Each role profile names its exact BWG/0.x version and publishes one reproducible command.
- [ ] Positive and negative fixtures cover work arithmetic, lifecycle, signatures, DPoP, event replay, expiry, rewards, privacy, and failure behavior.
- [ ] Implementations can self-certify only the profiles they actually pass.
- [ ] The reference account-creation journey passes through the hosted and self-hosted public seams.
- [ ] Standard Stratum and real Bitaxe paths both satisfy the same Gate Authority accounting and Redemption semantics.
- [ ] Every Core MVP success criterion has linked executable or hardware evidence.
- [ ] Mainnet evidence includes exact job admission and independent block-submission behavior.
- [ ] Residual risks and non-claims are published without weakening the protocol's stated guarantees.

## C Reference Firmware evidence — 2026-11-15

Mapped by the C-image Gate effort's Ticket 09. The criterion-by-criterion table
is in [`c-image-end-to-end-gate/spec.md`](../../c-image-end-to-end-gate/spec.md),
"Core MVP criteria against C-image evidence", and the physical evidence is in
the C repository's
[`docs/project/gate-integration-evidence.md`](https://github.com/bright-builds-llc/bitaxe-esp-miner-c/blob/2bb93f0/docs/project/gate-integration-evidence.md).
On the owner's reference image of the C firmware, the Gamma 601 and the Ultra
205 each completed a mainnet Gate through the deployed account-creation page,
the Pool Adapter and pinned Hydra, ending in a redeemed Gate Pass (criteria 1,
2, 6 to 9). Onboarding with the owner's signed package was proven on the 601
(criterion 3). Criteria 4, 5, 10, 11 and 13 are partial, and criterion 12 isn't
a firmware criterion.

Against this ticket's items:

- **Every criterion has linked evidence:** each has a C-image entry, but five are
  partial and criterion 12 has none.
- **Standard Stratum and real Bitaxe paths share accounting and Redemption:** the
  real Bitaxe path ran on the C image; this effort ran no standard Stratum Worker
  beside it.
- **Mainnet job admission and independent block submission:** the mainnet runs
  went through Hydra's Job Admission patch, but no job's admission is recorded,
  and no block was found, so block submission isn't shown.

Non-claims carried from the C-image evidence:

- Malformed payout and invalid proposal weren't run on the C image, and adapter
  replay and a fresh-proof reuse of a spent pass are Rust tests only.
- The handover and another Device Identity's context weren't run on hardware.
- The consent disclosure wasn't checked field by field. Its policy links don't
  resolve yet, and it names only the 601.
- The privacy audit covered board values in Authority requests, not Device
  Identity keys, Account Identity, payout or action payloads.
- Several Workers in one challenge weren't run.
- The node was Bitcoin Core 31.1, not the 28.1 pin.
- Most hardware cases ran once, some on one board only.
