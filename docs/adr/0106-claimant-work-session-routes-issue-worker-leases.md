# ADR-0106: Claimant Work Session routes issue Worker Leases

Accepted 2026-11-05, on the owner's choice for `c-image-end-to-end-gate` Ticket 01.
It adds claimant routes to the Gate Authority and changes no Controller,
deployment-trust or Gate Pass profile.

Under `/v0/challenges/{challenge_id}/work-session` the Authority serves `start`,
`resume`, `renew`, `pause` and `cancel`. Each is a POST authenticated by a
`bwg-work-session-proof+jwt` from the challenge's claimant key. The proof binds the
method, the exact URL, the challenge, a fresh issue time and the SHA-256 of the
exact request body, and its ID is single-use. Start and Resume return a Controller
0.4 `WorkerLeaseGrant`, and Renew returns a `WorkerLeaseRenewal`. Each one carries
a `bwg-worker-lease-authorization+jws` that ADR-0093 defines, over the
authorizationless request and the active Challenge, together with the
possession-derived control-session digest the request names.

Claimant Pause and Cancel live on these routes too, beside the Relying Service's
credentialed Pause and Cancel, which stay as they are. A claimant's stop shouldn't
depend on the site's backend being up or willing, and ADR-0026 treats cancellation
as part of consent. Resume confirms the paused session's restoration on the
claimant's behalf before it starts a new lease. The browser only resumes after its
Worker confirmed Mining Baseline. A Worker that didn't restore earns nothing,
because Pause ended its lease and its Stratum credentials.

The lease clock is the Authority's own clock in milliseconds, and its continuity ID
is the control-session digest. Renew under another digest is lost continuity and
ends the lease, and a clock that steps backwards fails closed the same way. Renew
after Pause, Cancel or expiry is refused by the existing session rules.

The Work Lease Authority key is its own deployment secret, an Ed25519 seed with its
own key ID and issuer label. The Authority refuses it if it matches a Gate Pass
key. Each key's sequence is allocated from a durable PostgreSQL row before signing,
and the allocator stops before `i64::MAX` instead of wrapping. Only test keys appear
in tests and fixtures. A Rust signer and the TypeScript signer produce
byte-identical authorizations, and shared vectors prove it.

Stratum credentials come through a port the Authority calls after it starts the
lease. The in-process adapter uses the Pool Adapter's credential issuer and session
registry, so the Authority never persists the Worker password; a gRPC adapter can
replace it as ADR-0022 plans. Pool Selection isn't an Authority route, because its
raw payout choice belongs only to the Pool Adapter boundary. Without the work-lease
configuration, these routes answer `worker_lease_unavailable`.
