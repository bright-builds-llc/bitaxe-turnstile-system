# Gate negatives harness for the C image

Type: task
Status: needs-triage
Blocked by: 08

## Objective

Ticket 08's first part (2026-11-09) ran the interruptions the Gate's deployed
page can drive on the Ultra 205. Its negatives need tooling the page doesn't
have, and some need both boards in one sitting. This ticket builds that tooling
and runs the negatives through the production path on the C image.

## Plan

- [ ] Withheld, expired-context and cross-possession authorizations fail before
  mining, and only the control-session digest reaches the Authority.
- [ ] The same possession request answered by the other board derives a different
  context and can't reuse the first board's authorization (both boards).
- [ ] A fresh admission after abrupt loss reports a positive
  `helloRecovery.discardedReplies` on the production path, through
  `interruptPendingStatusForQualification` or a passive observer.
- [ ] An adapter restart that keeps its outbox replays nothing creditable twice.
- [ ] A stale job while a lease mines, if a new tip can be timed into a run.
- [ ] Decide whether the page should let go of the USB port after a terminal
  Cancel. On `8844302` it kept the port, where completion and pool loss let go.
- [ ] Decide with the owner whether agent-driven tools may sign with the dev
  lease authority outside the launcher.

## Comments
