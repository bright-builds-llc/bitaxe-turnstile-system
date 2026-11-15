# Handed-over grants in two browser profiles

Type: task
Status: ready-for-agent
Blocked by: None

## Objective

Ticket 28 couldn't run `handed_over`. The deployed page takes one site-wide Web
Lock, `bwg-worker-serial` with `ifAvailable` (`web/webserial-worker-port.ts`),
before admission. Two tabs in one profile therefore can't both hold a Worker
Serial session: tab b's admission fails while tab a holds the lock. That is the
page's intended limit, so the harness must change, not the page.

## Plan

- [ ] `scripts/gate-negatives-harness.ts` runs `handed_over`'s two tabs in two
  Chrome profiles, each with its own debugging port, for example with a second
  `--browser`.
- [ ] Tab b's window comes to the front with its chooser, so the person picking
  ports can see it. In Ticket 28 each tab opened in a new window, and the owner
  never saw tab b's chooser.
- [ ] A test shows a second tab in one profile is refused admission by the lock,
  so the limit is recorded as a property, not only observed.
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
