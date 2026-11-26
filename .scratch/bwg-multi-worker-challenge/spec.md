# Several Workers in one challenge through the Claimant path

**Status:** needs-triage

## Why this is future work

Core MVP criterion 8 reads: "Reaching the Work Requirement ends every Work Lease and confirms
Mining Baseline restoration." On 2026-11-26 the owner limited the MVP to one participating Worker
per challenge, after scoping what several boards in one challenge would take. That path is kept here
as future work. Nothing in it is planned or claimed.

## What already works

- The domain lets a challenge gather work from several Workers (`docs/contexts/proof-of-work-gating/CONTEXT.md`,
  `docs/design/v1-onboarding.md`).
- The Authority credits several Work Sessions toward one challenge, and stops every one of them as
  `challenge_satisfied` once the threshold is crossed. `tests/multi_session_aggregation.rs` and
  `tests/composed_failover.rs` show this, through direct Pool Adapter calls only
  (`.scratch/bwg-multi-worker-failover`, resolved).
- Work Consent's duration estimate already sums several Workers.

## What the Claimant path lacks

Every layer between the page and the Authority admits one Worker per challenge:

- **Claimant routes.** `claimant_session_id` (`src/authority_application/worker_lease.rs`) derives
  one Work Session from the challenge, so Start, Renew, Pause, Resume and Cancel can't name a
  second board's session. A second Start would likely be refused, because `StartLease` is allowed
  only from `Ready` or `Restored` (`src/lifecycle/session.rs`). This wasn't run.
- **Restoration.** No Claimant route confirms a board's restoration after `challenge_satisfied`.
  `pass_issued` needs only every Work Lease ending or restored (`docs/design/v1-lifecycle.md`).
- **Headless SDK.** `HeadlessClientInput` takes several Workers but one controller, one release and
  one terminal restoration, and the HTTP transport holds one lease.
- **Consent.** `participatingWorkers` keeps only the connected board.
- **Page and browser.** The page opens one Worker Serial session. The site-wide `bwg-worker-serial`
  Web Lock (`web/webserial-worker-port.ts`) admits one per browser profile, and ADR-0101 still needs
  the chooser to pick one of several granted ports.
- **Harness and rehearsal.** The negatives harness fails any consent that names more than one
  Worker (`scripts/gate-negatives-cases.ts`). The rehearsal runs one fake Worker and one CPU miner.

## Paths seen so far

- **Through the page.** Per-Worker sessions on the Claimant routes with a cap, a Claimant
  restoration route, an SDK with a controller and lease per Worker, consent naming every connected
  board, a lock per port, a page flow to add a board and release every port, and a rehearsal and
  harness with two fake Workers. Then a mainnet sitting with the Gamma 601 and the Ultra 205. This
  crosses the Authority, the SDK, the page and the harness, and needs an ADR for the routes.
- **Below the page.** Two boards driven through the Pool Adapter or the Authority directly. This
  would show every lease ending on hardware, but not through the production browser path.

## Comments
