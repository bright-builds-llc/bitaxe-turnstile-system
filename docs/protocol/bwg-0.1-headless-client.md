# BWG/0.1 Headless Client

The framework-independent browser entry point is exported as `bwg-core/headless`. `bun run
build:browser` emits its browser ESM and declaration file under `dist/headless`, and `npm pack`
produces a self-hostable package containing that verified artifact. Ticket 13's SolidJS custom
element is an adapter over this contract rather than a second lifecycle.

Before challenge issuance, `prepareClaimantIdentity` generates a fresh WebCrypto P-256 key and
returns the public `claimantKey` JSON that the Relying Service binds into its challenge request. The
private key is non-extractable and is stored by the browser's structured-clone-capable IndexedDB;
callers receive no private-key handle. `createHeadlessClient` refuses a Work Challenge bound to any
other key, and an unbound preissuance key expires after at most five minutes. The opaque key ID
allows `restoreClaimantIdentity` to recover the same key after tab
closure while every signature still reads the clock and fails closed at expiry. Expired stored keys
are deleted on access or restoration. Only the trusted Authority event seam can extend retention
through a later Gate Pass or claimant-lookup artifact deadline.

Before consent, `createHeadlessClient` verifies the complete Pool Offer set against the configured
Authority key, Work Challenge, Action Policy, and visible offer bytes. It then produces one
immutable disclosure containing exact expected hashes, display-only Equivalent Binary-Zero Work,
selected Workers, duration and optional energy estimates, signed Pool Offer source/version/license
and Reward Policy terms, accepted payout choices, the selected payout destination, cancellation
behavior, and both claimant and client ceilings. Consent returns a SHA-256 digest of that snapshot
and persists the receipt beside the non-extractable key. A restored active challenge revalidates the
receipt and begins locally paused, so resume remains explicit. Estimates never enter Verified
Progress. A reconnect may also initialize directly from the Authority's current `satisfied` or
`pass_issued` snapshot without replaying missed intermediate events; both map to completed. Start
performs no transport work until `grantConsent` succeeds and refuses requirements above either
ceiling.

Elevated Action Policies and an Authority-signed `trusted_confirmation_required` Pool Offer claim
add a `TrustedConsentRequest` to the immutable disclosure. `grantConsent` then requires a compact
Authority-signed receipt whose challenge, disclosure digest, signed-offer digest, reason, origin,
and lifetime match exactly. The receipt must assert WebAuthn user presence, user verification, and
trusted non-self attestation. A missing, stale, wrong-origin, malformed, or invalidly signed receipt
fails before transport Start; the verified compact receipt is persisted with consent and forwarded
to the lease-start adapter for server-side enforcement.

The challenge field `trusted_consent_disclosure_digest_sha256` is Authority-derived and separately
validated from the client-local Work Consent disclosure digest. A trusted-required challenge without
that canonical 43-character value fails during client construction; an embedding backend cannot
substitute its own digest because the eventual Authority receipt must match it.

The caller supplies a narrow transport implementation for the public client, Pool Adapter, and
Authority-event seams; the headless module never accepts a Relying Service credential. Start,
Pause, resume, and terminal Cancel emit typed lifecycle events carrying the public challenge state
and local control state. `verified_progress` can arrive only from the Authority event subscription
and carries exact accepted hashes plus the immutable work requirement. `activity_estimate` is a
separate non-authoritative event. The lifecycle event union contains only valid public/control-state
pairs and uses completed, cancelled, and expired terminal states rather than implying resumability.
Events contain no private key, credential, action payload, payout destination, or unrelated
identity.

Local Worker flows may additionally supply the versioned public `WorkerController` interface from
`bwg-core/worker-controller`. Authority Start/resume returns an authenticated device grant; the
headless client forwards it, composes renewal, validates redacted status/restoration responses, and
rolls back both Worker and Authority on controller failure. `maybeWorkerCapabilities` and
`maybeWorkerStatus` expose only the strict non-secret contract. USB disconnect pauses Authority
after device-local restoration, while asynchronous `close()` requests `tab_closed` restoration.
Possession-bound deployments may separately supply `WorkerLeaseAuthorizationContextProvider`.
The client obtains its Device Identity-bound digest before Authority Start/resume and the active
context before renewal, then passes only that digest to the transport's authorization seam. The
stable `WorkerController` interface does not expose the context or change shape.
The complete wire and simulator profile is documented in
[`bwg-0.1-worker-controller.md`](./bwg-0.1-worker-controller.md).

The independent fixture at `conformance/bwg-0.1/headless-work-consent-vectors.json` includes a real
Ed25519-signed offer set. `bun run test:browser` loads the emitted ESM in Chromium and exercises
pre-issuance key binding, IndexedDB restoration, disclosure, explicit consent, controls, progress
separation, event privacy, and key exposure through browser-native WebCrypto. A second Chromium path
drives the production Authority begin/finish routes with a virtual authenticator, verifies the real
signed receipt in browser WebCrypto, and proves missing-versus-valid receipt behavior at production
lease admission. Exact-origin/source/state popup negatives and teardown abort behavior run alongside
it. This browser run is also part of `bun run test` and the aggregate `bun run verify` gate.
The dedicated Playwright conformance session ignores certificate errors only for its intercepted
synthetic `https://authority.example` route; production Authority TLS validation is unchanged.
