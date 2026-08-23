# 06: Prove composed governance recovery and close the parent lifecycle gap

**What to build:** Operators and Claimants have public evidence that concurrent or interrupted governance across both contexts preserves the complete BWG journey, and the parent lifecycle ticket records the resolved retention, deletion, export, and audit guarantees.

**Blocked by:** 05: Export redacted snapshots and audit governance operations.

**Status:** resolved

- [x] Composed tests cover cleanup and export during issuance, Redemption, action execution, lookup, process replacement, and independent context failure.
- [x] Stale manifests, crashes before and after commit, repeated apply, and export resume converge without duplicate transitions or omitted records.
- [x] Public interfaces prove protocol behavior before, during, and after each applicable Retention Floor; database rows are not acceptance oracles.
- [x] Representative output scans prove prohibited data is absent from exports, manifests, audit events, logs, and telemetry.
- [x] The BWG Core recovery matrix and parent Ticket 09 link this evidence and resolve their remaining governance acceptance criteria.

## Answer

Added a same-cluster composed test that races an Authority missing-key rollback against successful
Relying Service retirement, then resumes Authority from the unchanged manifest and proves repeated
apply plus both-context export convergence. The complete evidence set combines that test with the
existing public process-replacement, progress, adapter acknowledgement, Redemption, immutable
outcome, lookup-window, frozen export, and byte-redaction tests. The BWG recovery matrix and parent
Ticket 09 now link those seams and record the data-governance blocker as resolved.
