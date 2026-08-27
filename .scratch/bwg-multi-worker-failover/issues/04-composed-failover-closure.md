# 04: Compose failover, reconfirmation, and parent closure

**What to build:** Concurrent Workers, equivalent failover, material reconfirmation, threshold
issuance, and terminal lease shutdown complete one recoverable public journey and close the two
parent integration tickets.

**Blocked by:** 03: Fail over only between materially equivalent Pool Offers;
[`bwg-trusted-consent` Ticket 04](../../bwg-trusted-consent/issues/04-material-change-bridge.md).

**Status:** resolved

- [x] Equivalent endpoint-only failover preserves accepted progress and resumes work without a new
  confirmation ceremony.
- [x] A material replacement signs `trusted_confirmation_required`, remains blocked until a fresh
  matching Trusted Consent Receipt arrives, and rejects consent or receipts bound to old terms.
- [x] Public lifecycle and failover projections show safe per-session state, current/pending offer,
  and recovery category without exposing Worker identity to the Relying Service.
- [x] Concurrent threshold crossing creates one Gate Pass and terminally stops every current,
  replacement, and pending Work Session.
- [x] Worker, pool, Authority, Pool Adapter, and PostgreSQL interruption/restart scenarios converge
  without losing progress, duplicating issuance, or releasing unconfirmed work.
- [x] The composed evidence is linked from and resolves the remaining acceptance criteria in BWG
  Core Tickets 14 and 20.

## Answer

The Pool Adapter now exposes one restart-safe `PoolFailoverProjection` per authenticated replacement
decision. It reports only the opaque predecessor/candidate Work Session states, exact authenticated
current or pending Pool Offer, stop reason, and one of `automatic_equivalent`,
`trusted_confirmation_required`, or `trusted_confirmation_accepted`. The Relying-facing challenge
lifecycle remains challenge-scoped and aggregate; it receives no session, Worker, Device,
credential, payout destination, or failover identity.

Successive replacement resolves the nearest authenticated offer through the Work Session predecessor
lineage, so ordinary Worker replacement cannot reset later classification or disclosure to the
original challenge endpoint.

Pending material decisions now reserve their candidate Work Session identity under one shared
transaction-scoped advisory lock across every challenge and session-creation path. Direct session
registration and generic replacement therefore cannot race around fresh confirmation, even from a
different challenge. Trusted Consent persistence now applies the same reason-aware lifecycle matrix
as the domain: Elevated ceremonies remain issued-only, while material-term ceremonies may reserve,
initialize, and complete during active work and fail closed if the challenge becomes terminal.

`tests/composed_failover.rs` is the parent-closure evidence. One PostgreSQL-backed journey retains
accepted progress across a live database pause, Worker/pool interruption, endpoint-only equivalent
failover, and Authority/Pool Adapter restart; rejects a receipt for different material terms;
recovers and admits the exact confirmed candidate; crosses the threshold under concurrent session
delivery; stops leased and ready sessions; prevents a still-pending candidate from releasing after
completion; and recovers exactly one Gate Pass issuance after a second Authority restart.
