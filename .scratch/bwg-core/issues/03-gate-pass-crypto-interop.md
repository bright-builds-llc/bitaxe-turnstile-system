# 03: Prove Gate Pass cryptographic interoperability

**What to build:** A tested cryptographic profile proving that Authority signatures, browser-held Claimant keys, JWKS rotation, and DPoP work across the planned Rust and browser environments. This prefactor resolves the remaining algorithm and encoding questions before authorization code depends on them.

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] The mandatory Authority signature algorithm and browser DPoP algorithm are explicitly selected.
- [x] Rust and WebCrypto implementations verify the same positive vectors.
- [x] The Claimant private key remains non-extractable in the browser path.
- [x] Gate Pass key confirmation and DPoP access-token hashing interoperate exactly.
- [x] Unknown, symmetric, `none`, mismatched, and deprecated algorithm cases fail closed.
- [x] JWKS key identifiers, overlap, rotation, and retirement have executable vectors.
- [x] The results are suitable for later Client, Gate Authority, and Relying Service Conformance Profiles.

## Answer

Published the `BWG/0.1` cryptographic profile with fully specified `Ed25519` Authority JWS signatures and browser-compatible `ES256` DPoP. RFC 9864 makes the former polymorphic `EdDSA` identifier a deprecated negative case. Gate Passes use an explicit `bwg-gate-pass+jwt` type, trusted `kid` selection, exact Authority JWK metadata, RFC 7638 SHA-256 `cnf.jkt`, and RFC 9449 SHA-256 `ath` over the ASCII compact Gate Pass.

One shared fixture now drives Rust and WebCrypto verification for current and overlapping Authority keys, post-overlap retirement, Gate Pass signatures, the RFC 9449 DPoP proof, key confirmation, access-token hashing, and unknown, symmetric, `none`, mismatched, and deprecated algorithms. Bun continuously runs the WebCrypto suite alongside Rust. The checked-in browser harness was also exercised in Chromium and proved that WebCrypto creates the Claimant P-256 private key as non-extractable while leaving only the public JWK exportable. `bun run verify` passes.
