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
