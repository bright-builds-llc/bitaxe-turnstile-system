# Gate page keeps the USB port after a Cancel or an expiry

Type: bug
Status: ready-for-agent
Blocked by: None

## Objective

On `8844302`, after a terminal Cancel or a challenge expiry, the deployed page
restores the board but keeps the USB port open. Completion lets go of it after
redemption, and pool loss lets go through the controller's failure path.

The owner chose (2026-11-14) to close the port once restoration is confirmed,
for Cancel and for expiry alike. Only redeem's `finally` calls `client.close()`
today (`web/reference-account-page.ts`). `restorationReason` in
`web/headless-worker-control.ts` already treats all three terminal states the
same way.

## Plan

- [ ] Regression tests that fail before the fix: after a confirmed restoration
  for Cancel, and for expiry, the port is closed.
- [ ] A restoration that isn't confirmed keeps today's failure behaviour.
- [ ] Completion and pool loss are unchanged.

## Comments
