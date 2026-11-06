# Authority refuses uncreditable work terminally, and delivery stops retrying it

Type: task
Status: ready-for-agent
Blocked by: 11

## Objective

The owner settled Ticket 11's two open decisions:

- **Drop at the deadline.** An Accepted Work Event delivered after the
  challenge deadline is refused by the Authority's clock, whether or not the
  expiry has been recorded. Work can never complete a challenge after its
  deadline.
- **Terminal refusal.** The Authority returns a distinct, typed refusal for a
  share it won't credit: after Pause, after satisfaction, after the deadline,
  or under an unknown lease. Pool Adapter delivery records a refused event once
  and stops retrying it. It retries only network or server outages, with
  backoff.

## Plan

- [ ] A failing test pins the drop at the deadline, replacing Ticket 11's test
  of the current behavior.
- [ ] The Authority refuses delivery after the deadline by its own clock.
- [ ] The Authority returns a typed refusal, in the OpenAPI contract and the
  conformance fixtures.
- [ ] Delivery records a refusal once and stops; an outage retries with
  backoff. Both paths are tested.
- [ ] An ADR records both decisions.

## Comments
