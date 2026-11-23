# Privacy, consent and handover on both boards

Type: task
Status: ready-for-human
Blocked by: None

## Objective

One sitting with both boards that moves three Partial criteria using code that already exists:

- **Criterion 13:** the negatives audit's newer checks on the C image. The audit searches each
  board's Device Identity fingerprint, read from the page's own store. It allows the payout address
  only as the pool selection's `payout_destination`. It also searches every Start and Renew grant
  sent to a board. A full mining journey per board lets the audit see Renew grants and the
  redemption, which the negatives never reach.
- **Criterion 4:** each board's consent screen names that board alone. The 205 hasn't shown its own
  screen since the page began naming the connected board (`df7bc8e`).
- **Criterion 11:** the handover case from [Ticket 29](29-handed-over-in-two-profiles.md), on
  hardware.

Out by the owner's choice (2026-11-22): criterion 11's malformed payout address and invalid block
proposal. Both are refused before any board gets work.

## Plan

- [x] A `journey` case in `scripts/gate-negatives-harness.ts`. It passes every grant, waits for
  `pass_issued` and the page's redemption, and audits as the negatives do. It is named only
  explicitly, so a bare run never mines.
- [x] Every case records the Workers and duration the consent names, read before the consent click.
  A consent naming more than one Worker fails the case.
- [x] The rehearsal runs the journey with the three negatives.
- [ ] The sitting, per [run-sheet-32.md](../run-sheet-32.md):
  - a journey on each board;
  - `withheld` and `expired_context` on the 205;
  - `handed_over` with tab a on the 601 and tab b on the 205.
- [ ] Records go in the fork's `docs/project/gate-integration-evidence.md` and on this ticket, with
  non-claims, naming no endpoints, MACs or pool identities. Update criteria 4, 11 and 13 in
  `spec.md`.

## Comments

- 2026-11-22, the harness (branch `board-run-32`):
  - `scripts/rehearse-production-path.sh --negatives` passed all four cases in two runs of three,
    about 3.5 minutes each.
  - In the rehearsal, the journey started its lease, passed a Renew grant, reached `pass_issued`
    and redeemed with 200. The fake board restored as `challenge_satisfied` and the port was
    released. The audit searched the fingerprint and found no violation.
  - Each consent named one Worker, the rehearsal's CPU miner.
  - Mutation check: with the payout address planted in each Renew grant the audit sees, the
    journey failed with "the payout destination reached the board in tab a's renew grant".
  - In the first of the three runs, `expired_context` timed out waiting for the consent screen, so
    it never reached its Start. Nothing in this change runs before consent, so it looks like an
    existing race. The guess is that the withheld tab's site-wide Web Lock was still held when the
    next case's tab connected, but that isn't confirmed. If it happens at the sitting, the page sits
    on its connect step until the 600 s connect timeout.
