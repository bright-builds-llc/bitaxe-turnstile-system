# Lifecycle SSE expiry test flakes under load

Type: bug
Status: ready-for-agent
Blocked by: None

## Objective

`lifecycle_control`'s `connected_lifecycle_sse_emits_expiry_at_the_absolute_deadline`
sets the deadline to the current second plus one. That leaves anywhere from a
few milliseconds to a second before expiry. A stream that subscribes after the
deadline never sees `active`. The expiry task also sleeps in whole seconds,
against a two-second read timeout. It failed 1 run in 15 before Ticket 11, and
more often under the full suite.

## Plan

- [ ] Give the test a deadline with a fixed lead and a read timeout that covers
  the expiry task's whole-second sleep, without weakening what it asserts.
- [ ] Repeated full-suite runs pass.

## Comments
