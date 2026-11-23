# Privacy, consent and handover on both boards

Type: task
Status: resolved
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
- [x] The sitting, per [run-sheet-32.md](../run-sheet-32.md):
  - a journey on each board;
  - `withheld` and `expired_context` on the 205;
  - `handed_over` with tab a on the 601 and tab b on the 205.
- [x] Records go in the fork's `docs/project/gate-integration-evidence.md` and on this ticket, with
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
- 2026-11-23, the sitting, 12:20 to 12:34 UTC: every case passed on the owner's `247d2cd` image,
  with the Gate at `0be5ae1`. The records are in the fork's
  `docs/project/gate-integration-evidence.md`, "Ticket 32 on both boards".
  - The 205's journey: the consent named "Bitaxe Ultra 205" alone, estimating 70.4 s. It mined
    101 s, the audit searched 5 Renew grants, the Authority reached `pass_issued`, the redemption
    was answered 200, and the board stopped with `ok=1`.
  - The 601's journey: the consent named "Bitaxe Gamma 601" alone, estimating 29.3 s. It mined
    33 s, with 2 Renew grants searched, and ended the same way.
  - `withheld` and `expired_context` on the 205, and `handed_over` with tab a the 601 and tab b
    the 205: each challenge ended `cancelled` with Verified Progress 0 and no Gate Pass request.
    Neither board logged a lease. In `handed_over` each consent named only its tab's board.
  - Every audit searched both boards' Device Identity fingerprints and found no violation. No
    stale job was logged. Both boards ended paused with `mineOnBoot` 0.
  - The run sheet missed one step: the page reuses a port when exactly one is granted (ADR
    0101), so the test profile's serial grants were forgotten before each step after the first.
    Otherwise the 601's journey would have run on the 205.
  - Unexplained: the Authority issued three challenges that never got a session or a grant, each
    25 to 86 s before a step. The page mints one only on its Connect click, and the harness
    clicks once per tab. They ended unused at expiry.
  - The page's continuity store held three records for two boards after the 205's second
    admission, each with a retention expiry. The harness's note that the page clears the store
    when an attempt ends doesn't match that.
