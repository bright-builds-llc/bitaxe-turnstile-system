# Authority refuses uncreditable work terminally, and delivery stops retrying it

Type: task
Status: resolved
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

- [x] A failing test pins the drop at the deadline, replacing Ticket 11's test
  of the current behavior.
- [x] The Authority refuses delivery after the deadline by its own clock.
- [x] The Authority returns a typed refusal, in the conformance fixtures. The
  OpenAPI contract doesn't carry it; see the comment.
- [x] Delivery records a refusal once and stops; an outage retries with
  backoff. Both paths are tested.
- [x] An ADR records both decisions.

## Answer

ADR-0108 and commits `9838a0b`, `c443b06`, `7f4f6ad` and `502b853`.

- **Deadline.** `accept_work` compares the later of the receipt time and the
  Authority's clock with the deadline, and refuses with
  `challenge_deadline_passed`. A replay of an event credited before the
  deadline still returns its first acknowledgement.
- **Typed refusal.** `AuthorityApplicationError::WorkRefused` carries one
  `AcceptedWorkRefusal` reason. Every other error is an outage.
- **Delivery.** `AcceptedWorkSinkError::Refused` makes the outbox record the
  event once as `refused`, with its reason, and never claim it again. An outage
  releases the event for a retry after 1, 2, 4 … seconds, capped at five
  minutes. A crashed delivery still recovers when its lease expires. Pool
  Adapter migration 0004 adds the state and the retry time, and retention
  retires refused events.
- **Shared vectors.** `conformance/bwg-0.1/accepted-work-refusal-vectors.json`
  lists each reason code and the outage backoff.
  `tests/accepted_work_refusal_vectors.rs` holds the Rust adapter to it.

The tests:
- `tests/late_work_delivery.rs` covers each refusal reason, the deadline before
  its expiry is recorded, and the replay after it.
- `tests/stratum_v1_proxy/authority_delivery.rs` shows a refusal is terminal.
- `tests/stratum_v1_proxy/persistence.rs` shows an outage retries after backoff
  and a crashed delivery recovers.

## Comments

2026-11-05. Red before the fix: work delivered after the deadline was credited
while the challenge was still `active` in storage.

The owner's brief also asked for the refusal in the OpenAPI contract. No public
accepted-work route exists, and ADR-0022 puts this boundary on gRPC, so the
owner chose option (a): the refusal lives in the port's result and the shared
vectors, and OpenAPI is unchanged. A future gRPC adapter must reproduce the
vectors.

The first migration draft dropped the outbox's two-column lease-expiry check
instead of the state check, because both have default names. Tests caught it
before commit, and 0004 now drops `accepted_work_outbox_check1`.

Flakes under `bun run verify`; neither test was added or touched here:
- `lifecycle_control` SSE expiry, the Ticket 13 flake.
- `relying_service_persistence` `exhausted_action_attempts_create_one_immutable_failure`,
  with an `SSLRequest` protocol error on connect. Likely cause:
  `tests/support/postgres.rs` stops waiting at the first "ready to accept
  connections" log line. The postgres image prints that line once from its
  temporary init server, before it restarts. It passed 3 of 3 runs alone.
