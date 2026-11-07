# Deployment serves its operator policy, privacy and terms pages

Type: task
Status: needs-triage
Blocked by: None

## Objective

`scripts/launch-gate-deployment.sh` sets `BWG_OPERATOR_POLICY_URL`,
`BWG_PRIVACY_URL` and `BWG_TERMS_URL` to `/policies/operator`, `/privacy` and
`/terms` on the deployment's origin, as the Ticket 06 rehearsal does. The
consent screen links them, but `scripts/serve-gate-origin.ts` serves only the
reference page, so they return 404. Ticket 07 is the owner at their own board
and can run with them broken. Any claimant other than the owner can't.

## Plan

- [ ] Owner: decide the text of the three pages, or where they live.
- [ ] Gate: serve them from the deployment's origin, or point the variables at
  where they live, and check that each link resolves on the rehearsal and the
  launcher proof.
