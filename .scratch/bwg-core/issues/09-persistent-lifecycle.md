# 09: Prove persistent lifecycle recovery and data governance

**What to build:** The complete PostgreSQL-backed gate journey composes Authority and Relying Service recovery, at-least-once delivery, and data-governance behavior through public interfaces.

**Blocked by:** 08: Complete and redeem a proof-of-possession Gate Pass.

**Status:** claimed

- [x] A composed restart matrix covers accepted work, threshold crossing, signing, pass delivery, Redemption acceptance, action execution, and Outcome Lookup without changing public behavior.
- [x] Adapter acknowledgements support at-least-once resend without progress loss or duplication.
- [ ] Retention cleanup preserves replay safety, bounds claimant-facing retrieval, and applies the separate audit or product retention rules to Redemption Records and outcomes.
- [ ] Deletion, export, and audit behavior exclude prohibited identity and secret data across both persistence contexts.
- [x] Tests prove behavior through public interfaces rather than direct database assertions.

## Progress

Published `docs/protocol/bwg-0.1-recovery-matrix.md`, composing the public PostgreSQL-backed restart, resend, concurrency, response-loss, deadline, and terminal-outcome evidence from Tickets 06–08. The matrix also records the replay and claimant-facing retention invariants already enforced.

## Blocker

The remaining governance criteria do not define who may export or delete records, how that operator is authenticated and authorized, what export and audit schemas are public, which immutable accounting/Redemption facts may be deleted versus pseudonymized, or the longer audit/product retention periods. Claimant proof authorizes only bounded read-only lookup and cannot safely be expanded into operator data governance. Implementing endpoints or destructive behavior without those decisions would invent a privileged security contract and conflict with the agreed context boundaries.
