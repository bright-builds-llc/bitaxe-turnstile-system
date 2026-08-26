# 01: Verify an attested WebAuthn ceremony on the Authority

**What to build:** The production Gate Authority starts, persists, and finishes a one-use
challenge-bound WebAuthn ceremony whose trusted result cannot be minted by browser HTTP alone.

**Blocked by:** None

**Status:** resolved

- [x] Begin confirmation validates the Work Challenge, signed confirmation requirement, exact Pool
  Offer digest, Authority origin, and remaining challenge lifetime. The Authority derives and
  immutably binds the disclosure digest; Ticket 03 independently renders and checks that digest.
- [x] The Authority creates unpredictable one-use WebAuthn state and persists it server-side with a
  bounded deadline.
- [x] Registration options require user verification and direct attestation on the configured RP ID.
- [x] Finish verifies challenge, origin, RP ID, UP, UV, credential signature, and a non-self
  attestation chain rooted in operator configuration.
- [x] Self, none, untrusted, malformed, replayed, expired, mismatched, and concurrent finish attempts
  fail closed.
- [x] A successful finish records one metadata-only terminal verified ceremony for later receipt
  issuance without exposing credential or attestation material publicly.
- [x] Restart and response-loss retries converge without re-verifying or creating a second result.

## Comments

This ticket owns WebAuthn verification only. Receipt signing and lease admission are Ticket 02.

## Answer

The Gate Authority now derives the exact disclosure binding, reserves one durable Begin operation
before generating WebAuthn state, and persists only legal Starting, Pending, Verifying, Verified, or
Failed variants. Its strict production verifier requires UP, UV, RP/origin/challenge binding,
credential signature validation, and an operator-approved non-self attestation root plus AAGUID.
Fenced operation leases make concurrent, cancelled, expired, crashed, and restarted ceremonies
fail closed without duplicate verification; terminal transitions erase all credential options and
server state. A real packed YubiKey chain and deterministic negative vectors cover the verifier,
while PostgreSQL HTTP tests cover singleflight Begin, lifecycle races, recovery, response loss, and
terminal idempotence. Independent Standards and Spec reviews against `9dfc00e` pass.
The required format, Clippy, all-target build, full Rust suite, browser suite, packaging check, and
Bright Builds standards verifier also pass.
