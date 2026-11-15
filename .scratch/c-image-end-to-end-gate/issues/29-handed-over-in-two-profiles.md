# Handed-over grants in two browser profiles

Type: task
Status: ready-for-human
Blocked by: None

## Objective

Optional (owner, 2026-11-14): the run on both boards doesn't block Ticket 09. Do it when both
boards are out for another sitting.


Ticket 28 couldn't run `handed_over`. The deployed page takes one site-wide Web
Lock, `bwg-worker-serial` with `ifAvailable` (`web/webserial-worker-port.ts`),
before admission. Two tabs in one profile therefore can't both hold a Worker
Serial session: tab b's admission fails while tab a holds the lock. That is the
page's intended limit, so the harness must change, not the page.

## Plan

- [x] `scripts/gate-negatives-harness.ts` runs `handed_over`'s two tabs in two
  profiles. Tab b opens in its own CDP browser context in the same Chrome
  (`Target.createBrowserContext`), which has its own Web Locks and no serial
  grants, so one `--browser` is enough. `caseTabs` marks it.
- [x] Tab b's window comes to the front with its chooser, so the person picking
  ports can see it. In Ticket 28 each tab opened in a new window, and the owner
  never saw tab b's chooser. Before each click the harness now restores the
  tab's window and activates it. CDP shows tab b's chooser open in a visible
  Chrome; that it's in front of the owner is checked at the sitting.
- [x] A test shows a second tab in one profile is refused admission by the lock,
  so the limit is recorded as a property, not only observed.
  `scripts/run-worker-serial-lock-browser.mjs`, run by
  `scripts/verify-headless-browser.sh`, takes the lock with
  `acquireWorkerSerialLock` in real Chromium: a second tab in the same profile
  gets `already_owned`, and a tab in a second profile takes it.
- [ ] Run `handed_over` on both boards: tab a the 601, tab b the 205. Each page
  refuses the other tab's grant before `start_lease`, and the two bindings
  differ. Records as in Ticket 28.

## Comments

- 2026-11-14, from Ticket 28: the Gate's site now holds grants for both boards in
  the test profile. A second profile needs its own grants.
- Ticket 21's rehearsal passed `handed_over` because it installs its own page
  with a fake serial port (`rehearsalAdapter` in
  `scripts/gate-negatives-adapters.ts`). Check whether that page takes the lock
  at all; if not, the rehearsal should, so it shows the same limit.
- 2026-11-14, the harness and the rehearsal:
  - The rehearsal passed `handed_over` because its fake device kept its own
    per-page lock flag, so two tabs never met the site-wide lock. It now takes
    the real one through `acquireWorkerSerialLock`, shared with the production
    runtime in `web/webserial-worker-port.ts`. With tab b in its own profile,
    `scripts/rehearse-production-path.sh --negatives` passes all three cases.
  - A browser context needs Chrome started through `open` on macOS. Started
    from a shell, Chrome 157 aborted on the serial chooser's privacy check
    (`__TCC_CRASHING_DUE_TO_PRIVACY_VIOLATION__`), twice. Started through
    `open -na`, tab b's `requestPort` waits on its chooser. The harness's usage
    says so.
  - Tab b's context starts with no grants, so its chooser asks every run, and
    the owner picks the 205 there. Tab a keeps the test profile's grants for
    both boards, so its chooser asks too.
  - Mutation check: with every page taking a lock of its own name, the lock test
    fails with "a second tab in the same profile got held".
  - The rehearsal now shows the limit: with tab b moved back into tab a's
    profile, `withheld` and `expired_context` pass and `handed_over` fails,
    timing out at tab b's consent, as Ticket 28 did on the deployment.
