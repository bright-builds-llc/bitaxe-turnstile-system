# 03: Prove Gate Pass cryptographic interoperability

**What to build:** A tested cryptographic profile proving that Authority signatures, browser-held Claimant keys, JWKS rotation, and DPoP work across the planned Rust and browser environments. This prefactor resolves the remaining algorithm and encoding questions before authorization code depends on them.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] The mandatory Authority signature algorithm and browser DPoP algorithm are explicitly selected.
- [ ] Rust and WebCrypto implementations verify the same positive vectors.
- [ ] The Claimant private key remains non-extractable in the browser path.
- [ ] Gate Pass key confirmation and DPoP access-token hashing interoperate exactly.
- [ ] Unknown, symmetric, `none`, mismatched, and deprecated algorithm cases fail closed.
- [ ] JWKS key identifiers, overlap, rotation, and retirement have executable vectors.
- [ ] The results are suitable for later Client, Gate Authority, and Relying Service Conformance Profiles.
