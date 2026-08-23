# 01: Issue the first browser-safe Work Challenge

**What to build:** A Relying Service can create a Light Work Challenge through the public Gate Authority interface and give a Claimant an immutable browser-safe descriptor. This first vertical slice establishes the executable BWG Core spine, reference service, and public acceptance harness without pretending that later work or Redemption already exists.

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] An authenticated reference backend can request a challenge from a versioned Light Action Policy.
- [x] The returned descriptor binds an opaque Action Reference, Claimant key, Work Requirement, expiry, and protocol version.
- [x] Browser-visible data excludes service credentials, action payloads, account identifiers, and unrelated private data.
- [x] A caller cannot create authoritative policy through the browser-facing interface.
- [x] Public behavior is exercised through the initial account-creation acceptance harness.
- [x] Rust, Bun, and repository verification commands needed by this slice run reproducibly.

## Answer

Implemented the first public BWG Core issuance slice as two runnable Rust HTTP services around a validated domain core. The reference backend owns the opaque Action Reference and pins `account-creation.light.v1`; the authenticated Gate Authority derives `2^42` expected hashes, a 15-minute expiry, and `BWG/0.1`, returning only the browser-safe descriptor.

The account-creation harness exercises both services over public HTTP and covers successful issuance, unauthenticated Authority access, and attempted browser policy injection. Focused domain tests cover policy terms, bounded newtypes, canonical work values, expiry overflow, protocol validation, and validated Authority-response deserialization. `bun run verify` reproduces formatting, linting, all-target build, tests, and managed repository checks.
