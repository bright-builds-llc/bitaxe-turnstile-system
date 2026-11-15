# A second tab's refused admission gives no reason

Type: bug
Status: needs-triage
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

- [ ] Decide what the second tab says, for example that the Bitaxe is in use in
  another tab of this browser.
- [ ] A test that fails before the change: the lock held elsewhere, Connect,
  and the reason shown.

## Comments

- 2026-11-14, from Ticket 28: the first `withheld` and every `handed_over` try
  ended this way.
