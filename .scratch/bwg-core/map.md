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
- [Ticket 17](./issues/17-hydra-solo-integration.md) integrated the exact pinned external
  P2Poolv2/Hydra and Bitcoin Core sources in solo direct-payout mode: Authority-retained consent
  mints the Pool-facing payout identity, exact target-qualified Stratum work advances durable
  deduplicated progress, byte-level coinbase evidence proves full selected-destination allocation,
  and complete pre/post-restart journeys cover vardiff, rejection, reconnect, stale cleanup, and
  network-block submission ahead of local persistence.
- [Ticket 18](./issues/18-bip23-mainnet-job-admission.md) made mainnet job release fail closed: the
  exact per-connection candidate and solo-direct Reward Policy are independently checked before a
  JSON-null BIP 23 proposal receipt; bounded concurrency, a serialized generation gate, exact-job
  rollback, old-tip invalidation, metadata-only evidence, and secret-safe cleanup prevent stale,
  invalid, or unavailable validation from leaking work to a Worker.
- [Ticket 19](./issues/19-independent-block-submission.md) made network-qualified block submission
  independent of BWG availability: a type-bounded direct Bitcoin Core path precedes accounting;
  explicit accepted, duplicate, rejected, inconclusive, unavailable, and reorg behavior remains
  separate from an issued Gate Pass; and composed Authority, SSE, Relying Service, and PostgreSQL
  outages preserve Core acceptance while exposing the residual risk of uncredited observer loss.
- [Ticket 14](./issues/14-trusted-origin-consent.md) and
  [Ticket 20](./issues/20-multi-worker-pool-failover.md) now close through the Trusted Consent and
  Multi-Worker Failover child efforts: active material changes require exact Authority-origin
  WebAuthn reconfirmation, equivalent recovery preserves progress, safe Pool Adapter projections
  expose no Worker identity to the Relying Service, and concurrent completion stops every current
  session before one recoverable Gate Pass issuance.
- [Ticket 21](./issues/21-worker-controller-usb-contract.md) published the versioned local Worker
  Controller/USB contract, strict cross-repository fixtures/schema, a monotonic fail-safe simulator,
  and headless-client composition that restores Mining Baseline state without exposing device
  settings or credentials.
- [Ticket 22](./issues/22-settings-preserving-bitaxe-onboarding.md) added explicit user-gesture USB
  entry, strict signed Reference Firmware admission, bounded local encrypted Migration Backup,
  default NVS preservation, redacted post-reboot evidence, and verified A/B rollback before the gate
  resumes.
- [ADR 0091](../../docs/adr/0091-separate-local-worker-control-from-runtime-evidence.md) and the
  [`bwg-worker-usb-separation`](../bwg-worker-usb-separation/map.md) child effort now separate
  application-time Worker control from receive-only runtime evidence. Controller 0.2 will use a
  vendor-specific WebUSB control function beside CDC evidence, preserve the higher-level
  `WorkerController` interface, and make bootloader/application reacquisition an explicit
  prerequisite of Ticket 23 rather than weakening the firmware serial contract.

## Multi-worker failover boundary split

Ticket 20 originally required both a production replacement-offer path and fresh Trusted Consent
for material replacements. At the same time, `bwg-trusted-consent` Ticket 04 was blocked by the
whole of Ticket 20. That made each ticket depend on the other's completion rather than on a concrete
interface.

The unresolved work now uses the
[`bwg-multi-worker-failover`](../bwg-multi-worker-failover/map.md) child effort without renumbering
the BWG Core roadmap:

1. aggregate exact work across concurrent and successive sessions;
1. isolate failed leases and admit unlinkable replacement Workers;
1. establish the production equivalent-offer/pending-reconfirmation seam;
1. let [`bwg-trusted-consent` Ticket 04](../bwg-trusted-consent/issues/04-material-change-bridge.md)
   bind material terms to fresh signed confirmation; and
1. compose failover, reconfirmation, threshold issuance, terminal lease shutdown, and closure of
   parent Tickets 14 and 20.

The parent tickets are integration records, not prerequisites of their own child slices. This keeps
the implementation frontier acyclic and independently resolvable.

## Persistence boundary split

The former Tickets 06 and 07 created a dependency cycle: durable issuance and Redemption were acceptance criteria for Ticket 06, while their PostgreSQL foundation was assigned to Ticket 07 and blocked by Ticket 06. The unresolved sequence was split on 2026-08-23 so work can proceed one bounded persistence context at a time:

- [Ticket 06](./issues/06-authority-persistence-issuance-recovery.md) owns Gate Authority PostgreSQL accounting, issuance intent, signing recovery, and durable Issuance Lookup.
- [Ticket 07](./issues/07-relying-service-redemption-outcomes.md) owns Relying Service Pass Consumption, Redemption, execution intent, durable outcomes, and Outcome Lookup.
- [Ticket 08](./issues/08-dpop-gate-pass-redemption.md) retains the former Ticket 06 protocol work and completes the public cryptographic journey after both persistence foundations.
- [Ticket 09](./issues/09-persistent-lifecycle.md) retains the remaining former Ticket 07 system-wide recovery and data-governance evidence.

| Former ticket | Current ticket |
| ------------- | -------------- |
| 06            | 08             |
| 07            | 09             |
| 08–23         | 10–25          |
