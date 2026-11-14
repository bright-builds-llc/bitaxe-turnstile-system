# Gate page keeps the USB port after a Cancel or an expiry

Type: bug
Status: resolved
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

- [x] Regression tests that fail before the fix: after a confirmed restoration
  for Cancel, and for expiry, the port is closed.
- [x] A restoration that isn't confirmed keeps today's failure behaviour.
- [x] Completion and pool loss are unchanged.

## Answer

Root cause: the headless client knows when a terminal restoration is confirmed, but it had no way
to hand the Worker back. Only the serial entrypoint (`web/headless-worker-serial.ts`) can close the
port, and it did so only from its own `close()`, which the reference page calls in redeem's
`finally`. Cancel ended at `stopWorkerController`, and expiry at `restoreWorkerController`, with
the controller still open. Pool loss let go because the controller's own failure path closes it.

Fix:

- `HeadlessClientInput` gains an optional `maybeReleaseWorker(reason)`. The client calls it once a
  Cancel or an expiry restoration is confirmed: after `cancel()`'s stop succeeds, and after the
  Authority event that began the shared terminal restoration. A satisfied challenge doesn't call
  it, so completion still lets go at redemption.
- `connectWebSerialHeadlessClient` wires it to `controller.close(reason)`, which sends the session
  close with the restoration reason and closes the port. Its later `close()` is then a no-op.
- A confirmed Cancel now counts as the terminal restoration, so the Authority's `cancelled` report
  that follows sends no second `restore` to the released port.
- An unconfirmed restoration rejects as before and calls no release. The serial controller's
  failure path (`control_failed`) still closes the port, as today.

Tests: `web/headless-worker-serial.test.ts` (Cancel and expiry close the port, the later Authority
report sends nothing, completion keeps the port) and `web/headless-terminal-restoration.test.ts`
(an unconfirmed expiry restoration reports the failure and releases nothing). The Cancel, expiry and
later-report tests failed before the fix. Simulated boards only; Ticket 28 checks it on both boards.

## Comments
