# BWG Multi-Worker Failover

**Status:** ready-for-agent

## Problem Statement

BWG already records challenge-scoped Accepted Work, enforces continuous Work Leases, and
distinguishes equivalent from material Pool Offer changes. It does not yet compose those rules into
a production flow where concurrent and successive Work Sessions contribute safely, failed Workers
can be replaced, and pool failover cannot silently change consented terms.

Treating BWG Core Ticket 20 as one implementation ticket creates a dependency cycle. The ticket
needs material changes to obtain fresh Trusted Consent, while Trusted Consent Ticket 04 needs the
real replacement-offer seam from Ticket 20. The implementation must expose that seam before either
parent integration ticket can close.

## Solution

Keep BWG Core Ticket 20 as the parent integration ticket and deliver it through four vertical
slices. First aggregate exact work across concurrent and successive sessions. Next isolate failed
leases and admit replacement Workers without durable device identity. Then add a production
replacement-offer transition that automatically releases only materially equivalent signed terms
and leaves material changes pending. Existing Trusted Consent Ticket 04 consumes that exact seam to
bind fresh confirmation. A final composed slice proves failover, reconfirmation, visibility,
threshold issuance, and terminal lease shutdown before closing BWG Core Tickets 14 and 20.

## User Stories

1. As a Claimant, I want accepted work from several sessions to accumulate once, so that replacing a
   Worker does not discard progress or double count a share.
2. As a Worker owner, I want one failed Worker to end only its lease, so that healthy sessions may
   continue contributing.
3. As a privacy-conscious Worker owner, I want replacement admission to use fresh session-scoped
   credentials, so that BWG does not require durable device identity.
4. As a Claimant, I want endpoint-only failover among already consented equivalent offers, so that a
   pool outage can recover without unnecessary confirmation.
5. As a Claimant, I want economic, payout, beneficiary, or privacy changes held pending until fresh
   trusted confirmation, so that failover cannot redirect value or hashpower silently.
6. As an operator, I want failover and per-session state visible through safe identifiers and
   categories, so that recovery is diagnosable without leaking Worker identity.
7. As a Gate Authority, I want concurrent threshold crossing to create one issuance outcome and stop
   every remaining lease, so that no session continues authorized work after completion.

## Implementation Decisions

- Keep the Work Challenge as the sole exact accounting aggregate. Work Sessions contribute events;
  they do not own transferable progress.
- Preserve Authority-wide event and share-fingerprint deduplication across every session for the
  challenge, including replacements and retries.
- Treat Work Session credentials, connection generations, and extranonce reservations as
  replaceable operational identities. Do not introduce a durable Worker or Device Identity.
- Model replacement and failover as explicit persisted transitions with generation fencing. A
  caller-supplied equivalence or trusted-confirmation boolean is never authoritative.
- Load the consented Pool Offer and candidate signed Pool Offer from authoritative state, then use
  the existing pure classifier. Endpoint-only equivalent changes may proceed automatically.
- Represent a material candidate as pending reconfirmation. Do not release work, mint a lease, or
  mutate the consented offer until the signed Trusted Consent requirement and matching receipt pass.
- Let `bwg-trusted-consent` Ticket 04 own signed material reconfirmation. Let this effort's final
  ticket own composed failover evidence and parent-ticket closure.
- Keep public and Relying Service projections challenge-scoped and metadata-only. Worker-facing
  operational identifiers do not cross into Relying Service identity.

## Testing Decisions

- Use the existing pure Pool Offer classifier for focused equivalent/material vectors; do not
  duplicate classification rules in orchestration code.
- Use PostgreSQL-backed Authority and Pool Adapter tests for concurrent sessions, replacement,
  restart, lease expiry, response loss, and threshold races.
- Verify progress, lifecycle, issuance, and failover through public Authority, SSE, and Pool Adapter
  seams rather than direct database rows.
- Exercise endpoint-only failover and every material change category independently.
- Prove material candidates reach no Worker before reconfirmation and that old consent or receipts
  cannot authorize changed signed terms.
- Scan public events, logs, and Relying Service-visible data for Worker, connection, payout, and
  credential identity leakage.

## Out of Scope

- Persistent Worker accounts, remote Worker authorization, fleet inventory, or proof of device
  ownership.
- Load balancing, profit switching, payout redesign, custodial balances, or new pool economics.
- Treating a caller assertion, unsigned endpoint, or unverified replacement offer as equivalent.
- Closing Trusted Consent Ticket 04 before the production replacement-offer seam exists.

## Parent

This child effort closes
[BWG Core Ticket 20](../bwg-core/issues/20-multi-worker-pool-failover.md) and supplies the composed
material-change evidence needed by
[BWG Core Ticket 14](../bwg-core/issues/14-trusted-origin-consent.md).
