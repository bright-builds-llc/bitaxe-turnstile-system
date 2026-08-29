# 03: Publish possession-bound Controller 0.3 transport profiles

**What to build:** Publish additive Controller 0.3, Worker USB 0.2, and Local Device Possession
profiles that let the Reference Client establish and re-prove the exact Reference Firmware Device
Identity without pairing or exposing it to a backend.

**Blocked by:** 02: Prototype and publish Controller 0.2 transport fixtures.

**Status:** resolved

- [x] Worker Management defines Local Device Possession Proof and a system ADR records why serial,
  VID/PID, enumeration identity, and their hashes are only admission hints, while Controller 0.2
  and Worker USB 0.1 remain unchanged.
- [x] Controller 0.3 preserves Work Lease semantics and binds a signed Reference Firmware
  capability to `bwg-worker-usb/0.2`; USB 0.2 retains the exact descriptor topology while its
  vendor control function admits only possession and Controller frames.
- [x] `bwg-worker-possession/0.1` publishes one strict fresh-nonce `prove_possession` request and
  correlated Ed25519 JWS response bound to `purpose`, `possessionNonce`,
  `challengeBindingSha256`, capability digest, descriptor digest, and the running firmware source
  commit asserted by the Device Identity.
- [x] Initial admission establishes the Device Identity public-key fingerprint; reacquisition
  requires the exact same key under a fresh nonce without adding pairing or a persistent grant.
- [x] Strict runtime parsers and verification reject replay, weak or malformed keys, changed
  purpose/digests/key, unknown fields, oversized frames, and arbitrary-signing requests.
- [x] Versioned schemas, deterministic positive/negative fixtures, browser WebCrypto tests,
  protocol documentation, and explicit package subpaths are published without changing Controller
  0.2, Worker USB 0.1, or Controller 0.1.
- [x] Live or deployment Device Identity material remains local: no request contains Work Lease
  credentials and no live proof, key, fingerprint, or USB identity enters logs, evidence,
  telemetry, or public state. Clearly marked non-production fixture identities are permitted only
  in conformance artifacts.

## Answer

Controller 0.3 is an additive typed specialization of the unchanged Work Lease semantics and binds
its Update Authority-signed capability to Worker USB 0.2. USB 0.2 preserves the exact TinyUSB
descriptor while its vendor function admits only possession and Controller frames; Controller 0.2
and USB 0.1 remain unchanged compatibility exports. A shared signed-profile module keeps both
Controller implementations deep without duplicating capability, attestation, lease, renewal, or
status behavior.

`bwg-worker-possession/0.1` publishes one closed `prove_possession` request and correlated compact
Ed25519 JWS response. The one-shot verifier consumes its nonce before asynchronous work, binds the
exact purpose and three digests, verifies the canonical public JWK and signature, establishes a
SHA-256 Device Identity fingerprint, and optionally requires the previously established
fingerprint and expected running firmware source commit during reacquisition. Device-supplied failure text is normalized and arbitrary signing
shapes never reach the signer contract.

Strict Draft 2020-12 schemas and deterministic non-production fixtures cover initial admission,
same-key reacquisition, replay, every changed binding, replacement and weak keys, unknown fields,
arbitrary signing, and oversized framing. Separate ESM/declaration and conformance package
subpaths publish Controller 0.3, USB 0.2, and possession artifacts without changing prior profile
paths. The fixtures contain only a clearly marked public conformance identity and no private seed,
Work Lease credential, live Device Identity, or operational USB value.
