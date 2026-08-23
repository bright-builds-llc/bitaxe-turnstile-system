# 03: Retire Gate Authority records safely

**What to build:** A Gate Authority operator can apply bounded, resumable retirement to Authority records after every replay, signing, acknowledgement, and reconstruction floor while issuance and Accepted Work behavior remain stable through public interfaces.

**Blocked by:** 02: Plan retention through service-local operator CLIs.

**Status:** ready-for-agent

- [ ] Signed Gate Pass and replay-proof material is physically deleted immediately after its protocol floor.
- [ ] Additive terminal-time fields and safe backfill make legacy Authority operational rows ineligible before a proven terminal instant and eligible afterward.
- [ ] Eligible challenge, Work Session, fingerprint, Accepted Work Event, issuance intent, and outbox identity is pseudonymized at day 30 and its tombstone deleted at day 90.
- [ ] Related rows transition in bounded context-local transactions with a durable cursor and idempotent crash recovery.
- [ ] Public issuance, progress, restart, and stable adapter acknowledgement behavior remains correct until its Retention Floor.
- [ ] Tests prove failures roll back safely and emit no prohibited identity or secret data.
