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
    it never reached its Start. The cause wasn't a Web Lock race; see the next comment.
- 2026-11-22, the `expired_context` timeout, diagnosed:
  - Cause: `bun run build:browser` ran in the same checkout during that run. It empties `dist/`
    first, and the rehearsal server reads `dist/` on each request. `expired_context`'s tab clicks
    Connect about 4.7 s into a run, so its page loaded while the bundles were gone. The page never
    got its `bwg-work-gate` component, so neither the consent nor Cancel appeared. The build started
    at 17:12:43 UTC, 5 s after the stack was ready.
  - Repro: with the stack held, moving `dist/` aside for 3 s as `expired_context` loads fails it
    with the same two messages, two runs of two. The control runs between them passed.
  - Ruled out: 56 runs of `withheld,expired_context` with nothing building passed. They covered a
    held stack, every CPU core loaded, a fresh stack per run, and four Chromes at once. A probe of
    300 tab closes found no Web Lock outliving `Target.closeTarget`, even with no gap.
  - No code fix: the harness and the page behave correctly when their bundles are missing. The
    deployment's `serve-gate-origin.ts` also reads `dist/` per request, so the run sheet now forbids
    builds and checks in the Gate's checkout while the launcher runs.
