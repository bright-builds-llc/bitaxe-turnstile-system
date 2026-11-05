# Interruptions and negatives on the C image

Type: task
Status: ready-for-human
Blocked by: 07

## Objective

Repeat the failure cases of criterion 11 and Core Ticket 23's open items through
the production path on the C image, each ending challenge mining and confirming
restoration.

## Plan

- [ ] Pause, terminal Cancel, expiry, disconnect, tab close and reboot.
- [ ] Withheld, expired-context and cross-possession authorizations fail before
  mining, and only the control-session digest reaches the Authority.
- [ ] The same possession request answered by the other board derives a different
  context and can't reuse the first board's authorization.
- [ ] Pool failure, adapter replay and stale-job cases.
- [ ] A fresh admission after abrupt loss reports a positive
  `helloRecovery.discardedReplies`, which no firmware has shown yet
  (moved from `bwg-worker-serial` Ticket 15).

## Comments
