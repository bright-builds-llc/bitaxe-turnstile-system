# 06: Persist Authority accounting and recover Gate Pass issuance

**What to build:** PostgreSQL becomes authoritative for the Gate Authority's accepted-work transaction and durable Gate Pass issuance pipeline, so threshold completion survives crashes and always converges on one retrievable pass or one terminal issuance failure.

**Blocked by:** 05: Credit accepted work and stream Verified Progress.

**Status:** resolved

- [x] The Gate Authority owns a separate PostgreSQL schema, forward-only migrations, repository ports, and runtime configuration without cross-context database access.
- [x] Immutable challenge policy, Work Sessions, Accepted Work Events, Verified Progress, adapter acknowledgements, issuance intents, and pass metadata persist authoritatively.
- [x] One transaction deduplicates an accepted event and share fingerprint, calculates Credited Work, advances progress, records adapter acknowledgement state, and creates exactly one immutable issuance intent plus outbox entry at threshold crossing.
- [x] Issuance workers use reclaimable durable leases, select an eligible signing key only when signing succeeds, and atomically store one `kid` plus one exact compact JWS before the challenge-expiry deadline.
- [x] Claimant-authenticated Issuance Lookup returns `pending`, the identical stored JWS when `issued`, or terminal `failed` without signing, retrying, or extending the pass.
- [x] PostgreSQL-backed tests through public interfaces prove restart after accepted work, restart during signing, lease recovery, duplicate delivery, and response loss still yield one exact pass or one terminal failure.

## Answer

Implemented the Gate Authority as a PostgreSQL-backed application module with its own `gate_authority` schema and forward-only migrations. Challenge issuance, Work Session binding, Authority-wide event/share deduplication, exact Verified Progress, stable adapter acknowledgements, and threshold creation of one issuance intent plus outbox entry now commit through the repository port; SSE remains disposable fan-out over durable snapshots.

Gate Pass workers claim reclaimable 30-second leases, fail unsigned intents permanently at challenge expiry, select the active Ed25519 key only for a successful signing attempt, and atomically store its `kid`, temporal claims, and exact compact JWS. The runnable Authority continuously processes this outbox using `BWG_AUTHORITY_DATABASE_URL`.

Issuance Lookup now requires a fresh, request-bound ES256 Claimant Issuance Proof whose identity is durably consumed. PostgreSQL-backed public tests cover process replacement after challenge issuance and accepted work, stable event replay, concurrent duplicate shares, a crashed signing lease, lease recovery, identical pass retrieval after response loss and restart, proof replay/wrong-key/staleness, and terminal deadline failure. The existing public challenge, progress, discovery, and pass-to-Redemption suites were migrated to PostgreSQL.
