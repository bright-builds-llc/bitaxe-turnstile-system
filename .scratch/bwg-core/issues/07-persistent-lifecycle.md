# 07: Persist and recover the gate lifecycle

**What to build:** The complete gate journey survives process and delivery failures using PostgreSQL as the authoritative store, while public behavior remains identical to the in-memory reference journey.

**Blocked by:** 06: Complete and redeem a proof-of-possession Gate Pass.

**Status:** ready-for-agent

- [ ] Immutable challenge policy, Work Sessions, Accepted Work Events, progress, pass metadata, expiry state, and Redemption Records persist authoritatively.
- [ ] One transaction deduplicates an event, calculates work, advances progress, and records downstream intent.
- [ ] Restart between threshold crossing and pass delivery still yields one valid Gate Pass.
- [ ] Restart after accepted Redemption returns the same action outcome.
- [ ] Adapter acknowledgements support at-least-once resend without progress loss or duplication.
- [ ] Retention, deletion, export, and audit behavior exclude prohibited identity and secret data.
- [ ] Tests prove behavior through public interfaces rather than direct database assertions.
