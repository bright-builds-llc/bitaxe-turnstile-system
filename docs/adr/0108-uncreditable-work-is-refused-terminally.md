# ADR-0108: Uncreditable work is refused terminally

Accepted 2026-11-05, on the owner's choices for `c-image-end-to-end-gate` Ticket 12.
It changes the Pool Adapter's delivery semantics and no public route.

An Accepted Work Event delivered after its challenge deadline is refused. The
Authority compares the later of the adapter's receipt time and its own clock
with the deadline, so the outcome no longer depends on whether anything has
recorded the expiry yet. Work can never complete a challenge after its
deadline. A replay of an event credited before the deadline still returns its
first acknowledgement.

When the Authority won't credit an event, it returns a typed refusal with one
reason code:

- `unknown_work_lease`;
- `work_lease_ended`, after Pause or another stop;
- `worker_continuity_lost`;
- `work_lease_expired`;
- `challenge_satisfied`;
- `challenge_cancelled`;
- `challenge_deadline_passed`;
- `conflicting_event_replay`.

Any other failure is an outage. The Pool Adapter records a refused event once,
with its reason, and never delivers it again. It retries an outage with
exponential backoff, and a crashed delivery still recovers when its lease
expires. Refused events are retired like acknowledged ones.

The refusal belongs to the Authority-to-Pool Adapter boundary, which ADR-0022
puts on gRPC rather than the public OpenAPI. Today that boundary is the
in-process port. The shared fixture
[`accepted-work-refusal-vectors.json`](../../conformance/bwg-0.1/accepted-work-refusal-vectors.json)
fixes each reason's code and whether it's terminal, and every wire adapter
must reproduce it.
