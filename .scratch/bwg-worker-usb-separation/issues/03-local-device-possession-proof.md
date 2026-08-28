# 03: Publish possession-bound Controller 0.3 transport profiles

**What to build:** Publish additive Controller 0.3, Worker USB 0.2, and Local Device Possession
profiles that let the Reference Client establish and re-prove the exact Reference Firmware Device
Identity without pairing or exposing it to a backend.

**Blocked by:** 02: Prototype and publish Controller 0.2 transport fixtures.

**Status:** ready-for-agent

- [ ] Worker Management defines Local Device Possession Proof and a system ADR records why serial,
  VID/PID, enumeration identity, and their hashes are only admission hints, while Controller 0.2
  and Worker USB 0.1 remain unchanged.
- [ ] Controller 0.3 preserves Work Lease semantics and binds a signed Reference Firmware
  capability to `bwg-worker-usb/0.2`; USB 0.2 retains the exact descriptor topology while its
  vendor control function admits only possession and Controller frames.
- [ ] `bwg-worker-possession/0.1` publishes one strict fresh-nonce `prove_possession` request and
  correlated Ed25519 JWS response bound to `purpose`, `possessionNonce`,
  `challengeBindingSha256`, capability digest, and descriptor digest.
- [ ] Initial admission establishes the Device Identity public-key fingerprint; reacquisition
  requires the exact same key under a fresh nonce without adding pairing or a persistent grant.
- [ ] Strict runtime parsers and verification reject replay, weak or malformed keys, changed
  purpose/digests/key, unknown fields, oversized frames, and arbitrary-signing requests.
- [ ] Versioned schemas, deterministic positive/negative fixtures, browser WebCrypto tests,
  protocol documentation, and explicit package subpaths are published without changing Controller
  0.2, Worker USB 0.1, or Controller 0.1.
- [ ] Live or deployment Device Identity material remains local: no request contains Work Lease
  credentials and no live proof, key, fingerprint, or USB identity enters logs, evidence,
  telemetry, or public state. Clearly marked non-production fixture identities are permitted only
  in conformance artifacts.

## Answer

Pending.
