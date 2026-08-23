# 03: Retire Gate Authority records safely

**What to build:** A Gate Authority operator can apply bounded, resumable retirement to Authority records after every replay, signing, acknowledgement, and reconstruction floor while issuance and Accepted Work behavior remain stable through public interfaces.

**Blocked by:** 02: Plan retention through service-local operator CLIs.

**Status:** resolved

- [x] Signed Gate Pass and replay-proof material is physically deleted immediately after its protocol floor.
- [x] Additive terminal-time fields and safe backfill make legacy Authority operational rows ineligible before a proven terminal instant and eligible afterward.
- [x] Eligible challenge, Work Session, fingerprint, Accepted Work Event, issuance intent, and outbox identity is pseudonymized at day 30 and its tombstone deleted at day 90.
- [x] Related rows transition in bounded context-local transactions with a durable cursor and idempotent crash recovery.
- [x] Public issuance, progress, restart, and stable adapter acknowledgement behavior remains correct until its Retention Floor.
- [x] Tests prove failures roll back safely and emit no prohibited identity or secret data.

## Answer

Extended the Authority planner from replay identities to signed Gate Pass bytes, terminal challenge
aggregates, and Authority tombstones. Issued bytes retire at their signed expiry and subsequently
return `410 issuance_retired`; a 30-day aggregate transition inserts one HMAC-SHA-256 pseudonymized
tombstone and deletes all challenge-owned rows atomically; the tombstone is deleted at day 90.
Terminal-time projection and legacy backfill keep non-terminal rows ineligible. CLI and public HTTP/
Pool Adapter tests migrate real pre-Ticket-03 rows, populate every aggregate child class, prove
rollback on a missing key, replay the same stable acknowledgement and progress after process
replacement, expose explicit retired lookup, and keep the key and signed bytes out of operator
output. BWG/0.1 has zero verifier skew, so strict `now >= exp` rejection makes signed expiry the
first safe byte-retirement instant. Aggregate/proof candidates coalesce into one dependency-safe
item, and a first cleanup after day 90 converges directly to final aggregate deletion instead of
attempting to create an already-expired tombstone.
