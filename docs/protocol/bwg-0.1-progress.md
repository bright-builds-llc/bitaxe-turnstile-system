# BWG/0.1 Accepted Work and Progress

This slice defines the reusable accounting core and public progress stream exercised by the simulated Pool Adapter. PostgreSQL durability and recovery replace the in-memory tracer store in the persistent-lifecycle phase; the event, acknowledgement, projection, and SSE semantics remain unchanged.

## Accepted Work Event

Every target-qualified accepted event carries:

- stable Pool Adapter event identity;
- challenge-scoped Work Session identity;
- the 32-byte assigned target effective for the submitted result;
- server receipt time;
- stable share fingerprint;
- whether the result also met the Bitcoin network target;
- optional Worker-reported hashes, hashrate, and lucky-hash depth as explicitly non-authoritative telemetry.

The Gate Authority calculates Credited Work only from the assigned target. Worker reports, estimated activity, and accidental lucky depth never change Verified Progress or authorization.

## At-least-once acknowledgement

The first event identity and share fingerprint insert advances the exact projection and returns a stable acknowledgement. Event identities and share fingerprints are indexed Authority-wide, not only within one Work Challenge. Replaying the same authoritative event fields returns that same acknowledgement. Reusing an event identity with a different challenge, session, target, fingerprint, receipt time, or network-target outcome fails closed. A new event identity carrying an already-seen share fingerprint—within the same challenge or another one—receives a stable `duplicate_share` acknowledgement with no Credited Work. Replaying that duplicate delivery returns the same duplicate acknowledgement.

Work Sessions are registered against exactly one opaque Work Challenge before events are accepted. Unknown or cross-challenge sessions fail closed.

## Public lifecycle stream

`GET /v0/challenges/{challenge_id}/events` returns Server-Sent Events. A new subscriber first receives the current snapshot and then receives changes that actually advanced Verified Progress. Each `verified_progress` event contains:

- exact decimal `verified_progress`;
- exact decimal immutable `work_requirement`;
- whether the requirement is satisfied;
- a separate `activity_estimate` object.

Activity Estimate is currently `unavailable`. It is structurally separate so future share cadence or local telemetry cannot be mistaken for accepted target-derived work. A lagged subscriber receives `resync_required` and reconnects for a fresh exact snapshot.

Canonical event/share indexes, the projection, and the acknowledgement commit before SSE notification. A subscriber disconnect or fan-out failure cannot reject or partially roll back accepted accounting; reconnecting always starts from the exact committed snapshot.
