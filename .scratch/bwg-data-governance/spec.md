# BWG Data Governance

**Status:** ready-for-agent

## Problem Statement

Operators can recover BWG issuance, Redemption, and durable outcomes, but they cannot yet govern the
resulting records safely. The protocol defines replay and claimant-facing lookup bounds without
defining privileged retention, pseudonymization, deletion, export, audit, or incident behavior.
Inventing that behavior inside cleanup code would weaken context boundaries and create an unaudited
destructive security contract.

## Solution

Provide separate service-local governance CLIs for the Gate Authority and Relying Service. Each CLI
can plan without changing governed domain records, persist only the context-local metadata needed
to bind a later apply, explicitly apply that digest-bound plan in bounded resumable batches, and
stream a redacted snapshot export. A shared pure policy model enforces protocol
Retention Floors and hosted 30/90-day defaults, while persistence, authorization, jobs, cursors,
manifests, audit events, and failures remain context-local.

## User Stories

1. As a Service-Local Operator, I want to preview eligible records without mutation, so that I can review an irreversible operation safely.
2. As a Service-Local Operator, I want a digest to bind the reviewed plan, so that changed or stale plans fail closed.
3. As a Service-Local Operator, I want destructive behavior disabled by default, so that deployment alone cannot erase records.
4. As a Gate Authority operator, I want privileges limited to Authority records, so that I cannot accidentally govern Relying Service data.
5. As a Relying Service operator, I want privileges limited to service records, so that Authority availability and data remain independent.
6. As a protocol implementer, I want configured periods rejected below Retention Floors, so that replay and verification safety cannot be traded for storage pressure.
7. As a privacy-conscious Claimant, I want signed proofs and Gate Pass bytes erased promptly after they cannot validate, so that reusable artifacts are not retained unnecessarily.
8. As a privacy-conscious Claimant, I want identifying operational records pseudonymized after 30 days, so that incident evidence does not become indefinite identity history.
9. As a privacy-conscious Claimant, I want Pseudonymized Tombstones deleted after 90 days, so that even bounded correlation eventually ends.
10. As a Claimant, I want public Outcome Lookup to remain independent of governance retention, so that lookup expiry neither destroys records prematurely nor extends public access.
11. As a Relying Service, I want terminal Protected Action Outcomes to remain immutable until retirement, so that cleanup cannot reopen authorization or execution.
12. As a Gate Authority, I want stable Accepted Work acknowledgements preserved until their Retention Floor, so that adapter resend remains safe.
13. As an operator, I want cleanup to commit in bounded batches, so that locks and failure blast radius remain controlled.
14. As an operator, I want a crashed cleanup to resume at its last committed cursor, so that retries neither omit nor repeat transitions.
15. As an operator, I want a completed plan to be idempotent, so that an uncertain command response is safe to retry.
16. As an operator, I want exports to use a fixed Snapshot Cutoff, so that every page represents one coherent context state.
17. As an operator, I want an interrupted export to resume without duplicates or omissions, so that large exports remain operationally safe.
18. As a security reviewer, I want prohibited identity and secret data excluded byte-for-byte, so that redaction does not depend on field names alone.
19. As an auditor, I want privileged governance operations recorded, so that planning, export, deletion, failure, and recovery are attributable to one operation.
20. As a privacy reviewer, I want audit events to contain metadata rather than governed row payloads, so that auditing does not recreate the sensitive dataset.
21. As an incident responder, I want safe error categories, counts, durations, and cursors, so that failures are diagnosable without secrets.
22. As a deployment operator, I want shadow planning before destructive enablement, so that representative manifests can be reviewed before first effect.
23. As a self-hoster, I want to extend retention periods, so that local product obligations can be met without weakening mandatory minima.
24. As an integrator, I want existing Authority and Reference HTTP behavior unchanged, so that governance remains outside the claimant protocol.

## Implementation Decisions

- Add two context-specific governance CLI entry points with `plan-retention`, `apply-retention`, and `export` commands; do not add remote administration routes.
- Treat each CLI plus its context-specific PostgreSQL repository as one operator seam. Existing Authority and Reference HTTP routes remain the claimant-facing verification seams.
- Put eligibility, floors, configured durations, record classes, reasons, and planned actions in a pure typed policy module. Keep clocks, environment parsing, PostgreSQL, output, and telemetry in thin adapters.
- Use additive context-local migrations for Retention Jobs, Governance Manifests, durable cursors, Pseudonymized Tombstones, and governance audit events. Do not add cross-schema foreign keys, queries, or transactions.
- Default identifying terminal operational retention to 30 days and tombstone/audit retention to 90 days. Delete replay identities and signed artifacts immediately after their stricter protocol floors.
- Permit longer configured periods and reject shorter periods. Missing terminal timestamps make legacy rows ineligible until safely backfilled.
- Require destructive mode, exact manifest digest, and explicit confirmation for Destructive Apply. Plans are immutable and applying a completed plan is idempotent.
- Use context-specific HMAC-SHA-256 pseudonymization keys supplied at runtime, never stored in governed tables, audit events, exports, logs, or manifests.
- Stream versioned NDJSON from a stable Snapshot Cutoff, resume by export ID and sequence, and finish with a SHA-256 Governance Manifest. The service never persists the exported file.
- Keep Account Identity and application business records outside governance transitions even when a protected account-creation action created them.
- Roll out additive migrations and dry-run telemetry first; destructive apply remains explicitly disabled until representative evidence passes.

## Testing Decisions

- Test through the two governance CLIs, the existing public Authority/Reference HTTP interfaces, and exported NDJSON. Do not use direct database queries as acceptance oracles.
- Unit-test the pure policy seam with worked examples for safety floors, 30/90-day transitions, extended policies, and overflow or invalid configuration.
- Follow existing PostgreSQL integration-test support and public restart/response-loss patterns used by Authority and Relying Service persistence tests.
- Use one red-green tracer bullet at a time. Mock only time or unavoidable process boundaries; use PostgreSQL containers for persistence behavior.
- Scan serialized export, manifest, audit, log, and telemetry output for every prohibited field and representative secret value.

## Out of Scope

- Remote administration, multi-user operator identity, or a new network authentication protocol.
- Jurisdiction-specific compliance claims or legal retention advice.
- Account Identity, application business records, payout records, Device Identity, or Worker telemetry governance.
- Shortening any replay, validation, immutable outcome, or stable acknowledgement guarantee.
- Cross-context transactions, repositories, foreign keys, manifests, or audit streams.

## Further Notes

- Parent integration work remains `.scratch/bwg-core/issues/09-persistent-lifecycle.md`.
- The normative profile is `docs/protocol/bwg-0.1-data-governance.md`.
- Prototype primary source: `codex/prototype-bwg-data-governance-lifecycle` at
  `6a468d137d7cc7a4273bb00bdbe7266a1db68fcc`.
