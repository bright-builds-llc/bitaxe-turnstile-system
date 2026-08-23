# BWG Core Implementation Map

## Decisions so far

- [Ticket 01](./issues/01-first-work-challenge.md) established the first browser-safe issuance seam: the reference backend owns the opaque Action Reference and selects a versioned Light Action Policy; the browser supplies only its Claimant key and cannot author policy.
- [Ticket 02](./issues/02-exact-work-vectors.md) established canonical target-derived work: assigned targets and Credited Work use fixed-width unsigned big-endian binary, public JSON uses non-zero decimal strings, accumulation is checked, and Equivalent Binary-Zero Work remains display-only.
- [Ticket 03](./issues/03-gate-pass-crypto-interop.md) fixed the `BWG/0.1` cryptographic profile: Authority Gate Passes use fully specified `Ed25519`, browser DPoP uses non-extractable P-256 keys with `ES256`, and shared Rust/WebCrypto vectors cover key binding, hashing, fail-closed algorithms, and JWKS rotation.
- [Ticket 04](./issues/04-secure-issuance-authority-discovery.md) secured hosted issuance with verifier-only environment/audience/origin/policy-scoped credentials and overlap rotation, pinned bounded overrides into immutable challenges, and published a trust-neutral Authority Descriptor plus JWKS with fail-closed critical fields.
- [Ticket 05](./issues/05-accepted-work-progress.md) established target-derived Accepted Work accounting: challenge-scoped sessions, stable event/share deduplication and replay acknowledgements feed exact Verified Progress through SSE while Activity Estimate and every Worker-reported value remain non-authoritative.

## Persistence boundary split

The former Tickets 06 and 07 created a dependency cycle: durable issuance and Redemption were acceptance criteria for Ticket 06, while their PostgreSQL foundation was assigned to Ticket 07 and blocked by Ticket 06. The unresolved sequence was split on 2026-08-23 so work can proceed one bounded persistence context at a time:

- [Ticket 06](./issues/06-authority-persistence-issuance-recovery.md) owns Gate Authority PostgreSQL accounting, issuance intent, signing recovery, and durable Issuance Lookup.
- [Ticket 07](./issues/07-relying-service-redemption-outcomes.md) owns Relying Service Pass Consumption, Redemption, execution intent, durable outcomes, and Outcome Lookup.
- [Ticket 08](./issues/08-dpop-gate-pass-redemption.md) retains the former Ticket 06 protocol work and completes the public cryptographic journey after both persistence foundations.
- [Ticket 09](./issues/09-persistent-lifecycle.md) retains the remaining former Ticket 07 system-wide recovery and data-governance evidence.

| Former ticket | Current ticket |
| --- | --- |
| 06 | 08 |
| 07 | 09 |
| 08–23 | 10–25 |
