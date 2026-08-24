# 12: Obtain Work Consent through the headless client

**What to build:** A framework-independent browser client lets the Claimant understand, approve, observe, Pause, and Cancel bounded work without exposing private keys or trusting estimates as completion evidence.

**Blocked by:** 10: Pause, cancel, expire, and resume safely; 11: Disclose and select a solo Pool Offer.

**Status:** resolved

- [x] The client generates and retains a fresh non-extractable pairwise Claimant key only through artifact expiry.
- [x] Exact expected hashes, Equivalent Binary-Zero Work, duration, available energy estimate, Reward Policy, Pool Offer, Payout Destination, and participating Workers are presented before Start.
- [x] Work cannot start on page load or exceed the Claimant's configured ceiling.
- [x] Verified Progress and Activity Estimate remain distinct throughout the lifecycle.
- [x] Start, Pause, resume, and terminal Cancel map to the agreed public lifecycle.
- [x] Typed lifecycle events expose no private key, credential, action payload, or unrelated identifier.
- [x] Headless behavior is covered through browser-visible interfaces and independent protocol fixtures.

## Answer

The publishable `bwg-core/headless` ESM now prepares a non-extractable pairwise Claimant key before
challenge issuance, verifies the issued challenge's exact key binding and Authority-signed Pool
Offer set, and persists the key plus immutable consent receipt in IndexedDB for bounded recovery.
Expired, corrupt, mismatched, or multiply bound records fail closed; restored issued, active,
satisfied, and pass-issued snapshots retain the public lifecycle without replaying estimates as
progress. The immutable pre-Start disclosure binds exact work, estimates, complete pool economics
and provenance, checksum-valid payout selection, Workers, cancellation behavior, and both safety
ceilings. Only Authority events produce Verified Progress; Activity Estimate and valid lifecycle
pairs remain separate metadata-only event unions. Forty-eight focused headless tests, the shared
Rust/WebCrypto suites, a real Chromium run over an independent Ed25519 fixture, package dry-run,
and the full repository verifier pass. Standards and Spec reviews against `59ee940` both passed
with no remaining findings.
