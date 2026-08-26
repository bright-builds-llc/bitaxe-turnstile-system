# 03: Harden the trusted browser flow and prove the real receipt seam

**What to build:** The conforming component drives the production Authority ceremony and cannot
record consent or start work after cancellation, teardown, popup failure, or receipt rejection.

**Blocked by:** 02: Sign trusted receipts and enforce them at lease start.

**Status:** resolved

- [x] The trusted surface independently loads and verifies challenge and signed Pool Offer terms.
- [x] Popup transport is exact-origin, exact-source, state-bound, abortable, and time-bounded.
- [x] Component teardown closes the popup, removes listeners/timers, and prevents late Start.
- [x] Strict JWS profile, trust-key, signature, claim, time, origin, UP/UV, and attestation negative
  vectors each have focused coverage.
- [x] Real Chromium drives the production begin/finish routes, verifies a real signed receipt, and
  proves that receipt gates lease start.
- [x] Physical authenticator compatibility and attestation-root rollout risks are documented.

## Answer

The Gate Authority now serves a dark, no-store Trusted Consent surface that independently reloads
the immutable challenge, configured issuer, Authority JWKS, and signed Pool Offers before invoking
WebAuthn. Its strict wire and receipt parsers reject altered terms, malformed or forged JWS data,
wrong bindings, stale timing, missing UP/UV, and untrusted/self attestation. The popup and component
bind the exact origin, window, state, deadline, and abort signal; cancellation, teardown, terminal
Authority events, or late responses clear pending consent and cannot reach Start.

The production-browser conformance suite routes synthetic HTTPS to the real Rust Authority and
PostgreSQL-backed lease seam. Chromium proves missing receipts are rejected, the production
begin/finish flow returns a real signed receipt, and only that verified receipt admits a lease. It
also retains signed bytes while mutating raw enum, boolean, and payout-destination fields to prove
the trusted surface fails before WebAuthn begins. The browser challenge/origin/UP/UV proof composes
with Ticket 01's packed YubiKey attestation-chain vector; deployment documentation records the
remaining physical device/browser/OS matrix and attestation-root/AAGUID rollout risks. Independent
Standards and Spec reviews against `f0050dc` pass.
