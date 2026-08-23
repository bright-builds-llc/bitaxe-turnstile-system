# BWG Core Implementation Map

## Decisions so far

- [Ticket 01](./issues/01-first-work-challenge.md) established the first browser-safe issuance seam: the reference backend owns the opaque Action Reference and selects a versioned Light Action Policy; the browser supplies only its Claimant key and cannot author policy.
- [Ticket 02](./issues/02-exact-work-vectors.md) established canonical target-derived work: assigned targets and Credited Work use fixed-width unsigned big-endian binary, public JSON uses non-zero decimal strings, accumulation is checked, and Equivalent Binary-Zero Work remains display-only.
- [Ticket 03](./issues/03-gate-pass-crypto-interop.md) fixed the `BWG/0.1` cryptographic profile: Authority Gate Passes use fully specified `Ed25519`, browser DPoP uses non-extractable P-256 keys with `ES256`, and shared Rust/WebCrypto vectors cover key binding, hashing, fail-closed algorithms, and JWKS rotation.
- [Ticket 04](./issues/04-secure-issuance-authority-discovery.md) secured hosted issuance with verifier-only environment/audience/origin/policy-scoped credentials and overlap rotation, pinned bounded overrides into immutable challenges, and published a trust-neutral Authority Descriptor plus JWKS with fail-closed critical fields.
