# 06: Persist Authority accounting and recover Gate Pass issuance

**What to build:** PostgreSQL becomes authoritative for the Gate Authority's accepted-work transaction and durable Gate Pass issuance pipeline, so threshold completion survives crashes and always converges on one retrievable pass or one terminal issuance failure.

**Blocked by:** 05: Credit accepted work and stream Verified Progress.

**Status:** ready-for-agent

- [ ] The Gate Authority owns a separate PostgreSQL schema, forward-only migrations, repository ports, and runtime configuration without cross-context database access.
- [ ] Immutable challenge policy, Work Sessions, Accepted Work Events, Verified Progress, adapter acknowledgements, issuance intents, and pass metadata persist authoritatively.
- [ ] One transaction deduplicates an accepted event and share fingerprint, calculates Credited Work, advances progress, records adapter acknowledgement state, and creates exactly one immutable issuance intent plus outbox entry at threshold crossing.
- [ ] Issuance workers use reclaimable durable leases, select an eligible signing key only when signing succeeds, and atomically store one `kid` plus one exact compact JWS before the challenge-expiry deadline.
- [ ] Claimant-authenticated Issuance Lookup returns `pending`, the identical stored JWS when `issued`, or terminal `failed` without signing, retrying, or extending the pass.
- [ ] PostgreSQL-backed tests through public interfaces prove restart after accepted work, restart during signing, lease recovery, duplicate delivery, and response loss still yield one exact pass or one terminal failure.
