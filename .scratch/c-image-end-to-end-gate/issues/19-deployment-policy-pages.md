# Deployment serves its operator policy, privacy and terms pages

Type: task
Status: ready-for-human
Blocked by: None

## Objective

`scripts/launch-gate-deployment.sh` sets `BWG_OPERATOR_POLICY_URL`,
`BWG_PRIVACY_URL` and `BWG_TERMS_URL` to `/policies/operator`, `/privacy` and
`/terms` on the deployment's origin, as the Ticket 06 rehearsal does. The
consent screen links them, but `scripts/serve-gate-origin.ts` serves only the
reference page, so they return 404. Ticket 07 is the owner at their own board
and can run with them broken. Any claimant other than the owner can't.

## Plan

- [x] Owner (2026-11-15): agent-drafted pages in this repository, served by the
  deployment's origin, marked as drafts until the owner approves or rewrites them.
- [x] Gate: serve them from the deployment's origin, or point the variables at
  where they live, and check that each link resolves on the rehearsal and the
  launcher proof.
- [ ] Owner: review the drafts, fill the `[Owner: …]` markers, and remove the
  draft banner when the text is final.

## Design (approved by the owner 2026-11-15)

**Why.** Only the owner can claim today: the consent screen links privacy and
operator terms that return 404, and nobody else can know what they agree to.

**Approaches.** (1) Draft pages in this repository, served from the
deployment's origin. (2) Point the three variables at pages the owner hosts
elsewhere. The owner chose (1). Moving later is three settings.

**Pages.** Three static HTML files in `reference/policies/` (`operator.html`,
`privacy.html`, `terms.html`), styled like the reference page. Each opens with
a banner saying it is a draft not yet reviewed by the operator or a lawyer, and
its date. Text states only what the code does, with no promise it doesn't keep:

- **Privacy:** what each service stores (claimant key at the Authority, its
  thumbprint at the Relying Service, a random Action Reference, share
  fingerprints and times, the payout address's commitment at the Authority),
  that the raw payout address is held by the Pool Adapter until the challenge
  ends and is sent to the pool as its Stratum username, that no IP addresses
  are recorded, and the retention schedule (pseudonymized at 30 days,
  tombstones deleted at 90) as an operator-run step.
- **Terms:** what a lease is (60 s, renewed every 20 s, under the device's own
  settings), that block rewards go 100% to the chosen address with no fee and
  no balance, that work earns a single-use Gate Pass and no refund or payout
  guarantee, refusals, Cancel being terminal, the device's return to its own
  mining, and that the claimant uses their own hardware at their own risk.
- **Operator policy:** who runs the deployment, the Standard policy's limits
  (2^44 hashes, 15-minute challenge, 2-minute pass), fail-closed behaviour,
  and how to reach the operator.

Bracketed `[Owner: …]` markers hold what only the owner can supply or promise:
the operator's legal name, a contact, governing law, and whether retention runs
on a schedule.

**Serving.** `scripts/serve-gate-origin.ts` maps exactly `/policies/operator`,
`/privacy` and `/terms` to those files, test first in
`scripts/serve-gate-origin.test.ts`; every other path stays 404.
`scripts/serve-rehearsal-origin.ts` gets the same three routes, so the Ticket 06
rehearsal's links resolve too. The launcher proof
(`scripts/rehearse-gate-deployment-launch.sh`) checks all three return 200.

**Not in scope** (noted for the owner): the Pool Adapter's 30-day cleanup
(`src/stratum_v1/retention.rs`) runs in no binary, so the privacy page can't
claim it; and the signed pool offer shows a placeholder endpoint,
`stratum+tcp://pool.example:3333/` (`src/pool_offer.rs:477`), on the consent
screen.

## Comments

- 2026-11-15, built to the design and `plan-19.md`, and committed
  to main on 2026-11-16 after the owner approved it. Draft pages in
  `reference/policies/`; `POLICY_PAGES` and `policyPageFile` in
  `scripts/serve-gate-origin.ts` serve exactly the three paths, and
  `scripts/serve-rehearsal-origin.ts` uses the same table. Tests:
  `scripts/serve-gate-origin.test.ts` (the three paths, and near misses such as
  `/privacy/` and `/policies/../package.json` stay unmatched) and
  `scripts/policy-pages.test.ts` (the draft banner, nothing remote, and the
  claims a claimant could be misled by). The launcher proof
  (`scripts/rehearse-gate-deployment-launch.sh`) now requires each page to
  answer 200 as HTML, and passed on regtest. The rehearsal origin, started
  alone with a throwaway certificate, answered all three with 200 HTML, `HEAD`
  200 and `/privacy/` 404. `bun test` (1443 pass), `bun run typecheck` and
  `bun run check:standards` pass. A fresh reviewer found four sentences that
  promised more than the code does (the block reward, the deletion schedule,
  the Pool Adapter's share records, the device's return to mining); they and
  two more were reworded, each pinned by a test. Non-claims: the text is an
  agent's draft, reviewed by neither the owner nor a lawyer; the full Ticket
  06 rehearsal wasn't run with the pages; whether the pool's share chain makes
  a payout address public isn't covered; the Pool Adapter's cleanup and the
  placeholder pool endpoint stay open.
- 2026-11-18, the owner's answers: the operator is Bright Builds LLC; problems and
  privacy questions go to the turnstile repository's public issue tracker, with a
  warning to leave out personal details; an account is kept until its holder asks
  the operator to remove it, by hand; the operator runs the Gate Authority's and
  Reference Service's retention about once a month, and the Pool Adapter's sweep is
  on every 24 hours. `scripts/launch-gate-deployment.sh` now starts the Pool Adapter
  with `BWG_POOL_ADAPTER_RETENTION_INTERVAL_SECONDS=86400` and
  `BWG_GOVERNANCE_DESTRUCTIVE_ENABLED=true` (that process only), so the page's
  promise holds, and the launcher proof requires the sweep's start-up line with that
  interval: it failed with the settings removed and passed with them, on regtest.
  Four page tests pin the name, the schedule, removal on request and the problem
  tracker, each red first. `bun test` (1449 pass), `bun run typecheck` and
  `bun run check:standards` pass. Left for the owner: a private address for account
  removal and other personal requests, what hosting, network and proxy logs record,
  the providers that carry the traffic, warranty and liability wording, how the
  terms change and their governing law, and a review before the draft banner comes
  off. Non-claims: no monthly retention run is scheduled by the software; the
  Gate Authority's and Reference Service's schedule is the operator's undertaking.
