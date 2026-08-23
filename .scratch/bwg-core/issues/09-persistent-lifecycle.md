# 09: Prove persistent lifecycle recovery and data governance

**What to build:** The complete PostgreSQL-backed gate journey composes Authority and Relying Service recovery, at-least-once delivery, and data-governance behavior through public interfaces.

**Blocked by:** 08: Complete and redeem a proof-of-possession Gate Pass.

**Status:** ready-for-agent

- [ ] A composed restart matrix covers accepted work, threshold crossing, signing, pass delivery, Redemption acceptance, action execution, and Outcome Lookup without changing public behavior.
- [ ] Adapter acknowledgements support at-least-once resend without progress loss or duplication.
- [ ] Retention cleanup preserves replay safety, bounds claimant-facing retrieval, and applies the separate audit or product retention rules to Redemption Records and outcomes.
- [ ] Deletion, export, and audit behavior exclude prohibited identity and secret data across both persistence contexts.
- [ ] Tests prove behavior through public interfaces rather than direct database assertions.
