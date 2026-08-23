# 01: Issue the first browser-safe Work Challenge

**What to build:** A Relying Service can create a Light Work Challenge through the public Gate Authority interface and give a Claimant an immutable browser-safe descriptor. This first vertical slice establishes the executable BWG Core spine, reference service, and public acceptance harness without pretending that later work or Redemption already exists.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] An authenticated reference backend can request a challenge from a versioned Light Action Policy.
- [ ] The returned descriptor binds an opaque Action Reference, Claimant key, Work Requirement, expiry, and protocol version.
- [ ] Browser-visible data excludes service credentials, action payloads, account identifiers, and unrelated private data.
- [ ] A caller cannot create authoritative policy through the browser-facing interface.
- [ ] Public behavior is exercised through the initial account-creation acceptance harness.
- [ ] Rust, Bun, and repository verification commands needed by this slice run reproducibly.
