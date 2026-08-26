# 04: Compose failover, reconfirmation, and parent closure

**What to build:** Concurrent Workers, equivalent failover, material reconfirmation, threshold
issuance, and terminal lease shutdown complete one recoverable public journey and close the two
parent integration tickets.

**Blocked by:** 03: Fail over only between materially equivalent Pool Offers;
[`bwg-trusted-consent` Ticket 04](../../bwg-trusted-consent/issues/04-material-change-bridge.md).

**Status:** ready-for-agent

- [ ] Equivalent endpoint-only failover preserves accepted progress and resumes work without a new
  confirmation ceremony.
- [ ] A material replacement signs `trusted_confirmation_required`, remains blocked until a fresh
  matching Trusted Consent Receipt arrives, and rejects consent or receipts bound to old terms.
- [ ] Public lifecycle and failover projections show safe per-session state, current/pending offer,
  and recovery category without exposing Worker identity to the Relying Service.
- [ ] Concurrent threshold crossing creates one Gate Pass and terminally stops every current,
  replacement, and pending Work Session.
- [ ] Worker, pool, Authority, Pool Adapter, and PostgreSQL interruption/restart scenarios converge
  without losing progress, duplicating issuance, or releasing unconfirmed work.
- [ ] The composed evidence is linked from and resolves the remaining acceptance criteria in BWG
  Core Tickets 14 and 20.
