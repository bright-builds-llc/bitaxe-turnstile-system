# 05: Publish Worker deployment trust and Work Lease authorization

**What to build:** Publish the deployment-owned signing and verification profiles that bind an
Ultra 205 Reference Firmware capability and every complete Work Lease input without changing
Controller 0.3.

**Blocked by:** 04: Add the production Reference Client WebUSB adapter.

**Status:** resolved

- [x] Define separate replaceable **Update Authority** and **Work Lease Authority** roles and keys;
  one key can never satisfy both verification interfaces.
- [x] Publish `bwg-worker-lease-authorization/0.1` as a compact Ed25519 JWS carried inside the
  existing opaque Controller 0.3 `authorization` string, with protected type
  `bwg-worker-lease-authorization+jws`.
- [x] Define a compact protected header bounded to `alg`, a maximum-32-character `kid`, and `typ`,
  where `kid` is exactly `[A-Za-z0-9_-]{1,32}` ASCII bytes, plus a closed payload containing only
  `operation`, `requestSha256`, `controlSessionBindingSha256`, and `sequence`. `operation` is
  exactly `start` or `renew`; it does not repeat the Controller command spelling. Sequence is
  canonical unsigned 64-bit decimal in
  `1..=18446744073709551615` with no leading zero. The keyed trust configuration supplies the
  fixed issuer, audience, role, and profile.
- [x] Prove the maximum legal compact JWS is exactly 481 bytes and fits Controller 0.3's unchanged
  512-byte `authorization` field; publish the worked byte budget plus exact 511/512/513-byte
  boundary vectors.
- [x] Bind Start authorization to the exact authorizationless canonical grant: operation, protocol,
  Lease ID, Challenge ID, Stratum endpoint/user/password, duration, and renewal hint. Bind Renew to
  its exact authorizationless canonical renewal plus the active Challenge ID.
- [x] Publish a separate `WorkerLeaseAuthorizationContext` interface without changing
  `WorkerController`. The possession-bound WebUSB adapter derives a
  `bwg-worker-control-session/0.1` digest from the canonical verified possession transcript
  (request plus signed response/JWK). The transcript already binds the fresh nonce, Challenge,
  capability, descriptor, and Device Identity. The Authority sees only the final domain-separated
  context digest, never the transcript, proof, JWK, fingerprint, or USB identity.
- [x] Require a fresh possession-derived context before each Start following baseline restoration.
  Firmware accepts Start only within a maximum 60-second local monotonic context window, retains
  that binding only for the active lease's Renew authorizations, and invalidates it on Pause,
  Cancel, expiry, explicit Restore, disconnect, reboot, monotonic reset, or control failure.
- [x] Allocate each Work Lease Authority key's authorization sequence durably and monotonically.
  Firmware must atomically persist a per-key accepted-sequence high-water mark before starting or
  renewing work and reject every non-increasing sequence across restoration and reboot. Allocation
  exhaustion fails closed without wrapping, key reuse, or signing.
- [x] Reject wrong issuer, audience, role, key ID, operation, request digest, Lease/Challenge
  binding, Stratum terms, duration, renewal hint, algorithm, type, unknown fields, malformed key,
  signature, retired key, reused sequence, or persistence failure without exposing signed input.
- [x] Add a service-local development deployment authority tool that creates two mode-`0600`
  Ed25519 private keys beneath an owner-only path outside both repositories, emits public JWKs
  separately, signs only closed capability/authorization inputs, and never prints private bytes.
- [x] Issue an Ultra 205 revision `205` Controller 0.3 capability bound to the final exact Worker USB
  0.2 application descriptor and publish its Update Authority public trust configuration for the
  Reference Client.
- [x] Support explicit public-key overlap and retirement for both authorities. Retain each accepted
  sequence high-water mark through overlap and remove it only with the retired key under an
  explicit destructive local operation.
- [x] Publish strict schemas, runtime parsers/verifiers, fixtures, package subpaths, byte-level
  privacy tests, sequence-one/maximum/overflow tests, same-nonce/different-Device-Identity tests,
  withheld-then-late and cross-session replay tests, replay-before/after-restore/reboot tests,
  context-window boundary tests, crash-before/after-high-water-commit tests, and real-process CLI
  conformance. Every committed private-key scan must remain clean.
- [x] Do not add a remote administration API, Device Identity registry, Controller version bump,
  wall-time authorization decision, or fixture-key promotion.

## Answer

Published role-separated Update and Work Lease trust, strict canonical Ed25519 verification,
possession-bound Start/Renew authorization, executable replay/context conformance, and a protected
crash-recoverable development authority CLI. The browser adapter now obtains possession context
before Authority issuance without changing Controller 0.3. Standards review passed; `bun run
verify` passed with all Rust, WebCrypto, Chromium, package, and Bright Builds checks green.
