# A second tab's refused admission gives no reason

Type: bug
Status: resolved
Blocked by: None

## Objective

While one tab holds the site's Worker Serial lock (`bwg-worker-serial` in
`web/webserial-worker-port.ts`), Connect in a second tab ends at
"Worker Serial admission_failed", with nothing the person can act on. When the
site holds one grant, the second tab also reuses that port with no chooser, so
a second attached board can't be picked there either. In Ticket 28 this looked
like a page that never offered consent. The lock's refusal is already typed,
`serialFailure("already_owned")` in `acquireLock`, but the page shows only
`admission_failed`.

## Plan

- [x] Decide what the second tab says: "Another tab of this site is already
  connected to a Bitaxe. Finish or close that tab, then connect again."
- [x] A test that fails before the change: the lock held elsewhere, Connect,
  and the reason shown.

## Comments

- 2026-11-14, from Ticket 28: the first `withheld` and every `handed_over` try
  ended this way.
- 2026-11-14, from Ticket 29: where the reason is lost. In `#admit` in
  `web/worker-serial-controller-runtime.ts`, port selection starts before
  `acquireLock`, so a refused tab still opens the chooser and the person picks
  a port for nothing. The refusal then leaves stage `ownership`, and
  `workerSerialFailureCategory` turns `already_owned` into `operation_failed`,
  since `already_owned` isn't in `observableCategories` in
  `web/worker-serial-errors.ts`. The caller sees only `admission_failed`. The
  stage, `ownership`, is enough to name the cause, so the fix may need no new
  category. Selection starts first on purpose, to keep the chooser within the
  click's user activation, so moving the lock ahead of it needs the lock taken
  without an `await` before `requestPort`.
- 2026-11-15, the fix. Admission now
  rethrows a refused lock's `already_owned` instead of `admission_failed`
  (`requestPermission` in `web/worker-serial-controller-runtime.ts`), and the
  reference page maps it to the sentence above through `connectFailureMessage`
  in `web/reference-account-page.ts`. Any other failure keeps its own text.
  `observableCategories` is unchanged, since the deployment-trust contract
  enumerates it, so a qualification hook still records the refusal as
  `operation_failed` at stage `ownership`. The test fixture's lock now fails
  with `already_owned`, as the browser's does. Tests:
  `web/webserial-worker-controller.test.ts` (the lock held, then Connect,
  rejects with `already_owned`; it failed with `admission_failed` before the
  change) and `web/reference-account-page.test.ts` (the message for
  `already_owned`, and another failure's own text). `bun test` (1431 pass),
  `bun run typecheck`, `bun run build:browser` and `bun run check:standards`
  pass. Non-claims: not run in a real browser with two tabs; the chooser still
  opens before the lock's answer, because selection must start within the
  click's user activation; the work challenge created before Connect is left
  to expire; a second tab still reuses the site's one grant, so a second board
  can't be picked there; pages other than the reference account page still
  show `Worker Serial already_owned`.
- 2026-11-15: the owner closed the ticket; the fix is on `main` as `e153241`.
