# BWG Core Implementation Map

## Decisions so far

- [Ticket 01](./issues/01-first-work-challenge.md) established the first browser-safe issuance seam: the reference backend owns the opaque Action Reference and selects a versioned Light Action Policy; the browser supplies only its Claimant key and cannot author policy.
- [Ticket 02](./issues/02-exact-work-vectors.md) established canonical target-derived work: assigned targets and Credited Work use fixed-width unsigned big-endian binary, public JSON uses non-zero decimal strings, accumulation is checked, and Equivalent Binary-Zero Work remains display-only.
- [Ticket 03](./issues/03-gate-pass-crypto-interop.md) fixed the `BWG/0.1` cryptographic profile: Authority Gate Passes use fully specified `Ed25519`, browser DPoP uses non-extractable P-256 keys with `ES256`, and shared Rust/WebCrypto vectors cover key binding, hashing, fail-closed algorithms, and JWKS rotation.
- [Ticket 04](./issues/04-secure-issuance-authority-discovery.md) secured hosted issuance with verifier-only environment/audience/origin/policy-scoped credentials and overlap rotation, pinned bounded overrides into immutable challenges, and published a trust-neutral Authority Descriptor plus JWKS with fail-closed critical fields.
- [Ticket 05](./issues/05-accepted-work-progress.md) established target-derived Accepted Work accounting: challenge-scoped sessions, stable event/share deduplication and replay acknowledgements feed exact Verified Progress through SSE while Activity Estimate and every Worker-reported value remain non-authoritative.
- [Ticket 06](./issues/06-authority-persistence-issuance-recovery.md) made Gate Authority accounting and issuance PostgreSQL-authoritative: one transaction persists accepted work, stable acknowledgement, progress, and threshold outbox intent; leased workers recover signing and store one exact pass; fresh Claimant Issuance Proofs retrieve durable `pending`, `issued`, or `failed` state.
- [Ticket 07](./issues/07-relying-service-redemption-outcomes.md) made Relying Service authorization and outcomes PostgreSQL-authoritative: Action References pin Claimant/type/policy before challenge issuance, atomic Redemption separates pass consumption from action idempotency, leased workers produce immutable outcomes, and fresh Claimant Outcome Proofs provide bounded read-only recovery.
- [Ticket 08](./issues/08-dpop-gate-pass-redemption.md) finalized the BWG/0.1 proof-of-possession wire journey: mandatory action/type/policy pass claims, dedicated Issuance and Outcome proof profiles, OpenAPI 3.1, shared Rust/WebCrypto lookup vectors, and one complete Standard-policy public acceptance path.
- [Ticket 09](./issues/09-persistent-lifecycle.md) completed composed persistence recovery and the
  [`bwg-data-governance`](../bwg-data-governance/map.md) child effort: service-local 30/90-day
  retirement, exact resumable exports, metadata-only audits, and independent context failure
  recovery now close the remaining lifecycle gap.
- [Ticket 10](./issues/10-pause-cancel-expiry.md) made interruption behavior deterministic: a pure
  persisted challenge/session state model drives authenticated Pause and terminal Cancel, every
  new event is admitted under one continuous monotonic Work Lease, typed SSE publishes lifecycle
  and deadline expiry, and restart, clock-loss, and control/accounting races fail closed without
  losing stable event replay.
- [Ticket 11](./issues/11-solo-pool-offer.md) made pool economics consentable and immutable:
  challenge-bound signed Pool Offers disclose separate pool/adapter source and license terms,
  checksum-valid direct-payout choices become durable opaque commitments, Work Sessions require a
  consented selection, and equivalent failover is distinguished from economic or privacy change.
- [Ticket 12](./issues/12-headless-work-consent.md) made bounded browser work explicitly
  consentable: a publishable framework-independent client verifies challenge/key and signed Pool
  Offer bindings, persists non-extractable pairwise keys and immutable consent for recovery, keeps
  Authority Verified Progress separate from activity estimates, and maps valid lifecycle controls
  through independently signed fixtures exercised in real Chromium.
- [Ticket 13](./issues/13-accessible-web-component.md) added the packaged SolidJS custom element:
  inline, modal, and full-page Shadow DOM presentations adapt the headless lifecycle, disclose exact
  signed economics before consent, expose accessible progress/control/fallback states, and complete
  a plain-HTML simulated account-creation journey with visible build and source provenance.
- [Ticket 15](./issues/15-stratum-v1-proxy.md) added the transparent Rust Stratum V1 Pool Adapter:
  generation-bound verifier-only admission and durable connection-scoped extranonces preserve
  standard Worker traffic; job-bound exact targets and reconstructed Bitcoin headers produce stable
  Accepted Work Events; submit-time lease observations, persistence-before-acknowledgement,
  upstream-first ordering, at-least-once Authority delivery, and bounded operational retirement
  preserve accounting and block-candidate safety across failure and restart.
- [Ticket 16](./issues/16-hydra-job-admission-seam.md) fixed the generic Hydra/P2Pool extension seam:
  pinned primary-source evidence and a runnable source prototype place a latest-generation-wins Job
  Admission port between exact per-connection candidate construction and tracker/socket publication;
  fresh BIP 23 JSON-null acceptance is fail-closed, while network-valid block submission remains
  independent of BWG accounting.

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
