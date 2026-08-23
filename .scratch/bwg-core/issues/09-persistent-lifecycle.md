# 09: Prove persistent lifecycle recovery and data governance

**What to build:** The complete PostgreSQL-backed gate journey composes Authority and Relying Service recovery, at-least-once delivery, and data-governance behavior through public interfaces.

**Blocked by:** 08: Complete and redeem a proof-of-possession Gate Pass.

**Status:** resolved

- [x] A composed restart matrix covers accepted work, threshold crossing, signing, pass delivery, Redemption acceptance, action execution, and Outcome Lookup without changing public behavior.
- [x] Adapter acknowledgements support at-least-once resend without progress loss or duplication.
- [x] Retention cleanup preserves replay safety, bounds claimant-facing retrieval, and applies the separate audit or product retention rules to Redemption Records and outcomes.
- [x] Deletion, export, and audit behavior exclude prohibited identity and secret data across both persistence contexts.
- [x] Tests prove behavior through public interfaces rather than direct database assertions.

## Progress

Published `docs/protocol/bwg-0.1-recovery-matrix.md`, composing the public PostgreSQL-backed restart, resend, concurrency, response-loss, deadline, and terminal-outcome evidence from Tickets 06–08. The matrix also records the replay and claimant-facing retention invariants already enforced.

## Resolution

The dedicated [`bwg-data-governance`](../../bwg-data-governance/map.md) child effort resolved the
privileged contract without expanding Claimant proofs: separate service-local roles now plan and
apply context-local retention, stage identifying records through 30/90-day retirement, stream
resumable redacted exports, and persist metadata-only audit evidence. Public and CLI tests cover
restart, response loss, stable acknowledgement, immutable outcome lookup, independent context
failure, exact manifests, prohibited-byte scans, and eventual audit/export-snapshot deletion.

## Answer

The complete PostgreSQL-backed lifecycle now composes Authority and Relying Service recovery with
operator-authorized data governance. Evidence is indexed in
`docs/protocol/bwg-0.1-recovery-matrix.md` and the child effort map.
