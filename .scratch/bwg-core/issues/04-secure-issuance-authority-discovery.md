# 04: Secure challenge issuance and publish Authority discovery

**What to build:** A hosted or self-hosted Relying Service can authenticate to the Gate Authority, select an immutable Action Policy revision, and discover the Authority's public capabilities and trust material without granting trust through discovery itself.

**Blocked by:** 01: Issue the first browser-safe Work Challenge; 03: Prove Gate Pass cryptographic interoperability.

**Status:** resolved

- [x] Hosted service credentials are high-entropy, scoped, environment-specific, and safely rotatable.
- [x] Service credentials are accepted only through the backend interface and never appear in browser data.
- [x] Action Policy revisions are immutable once a challenge is issued.
- [x] Only explicitly permitted bounded overrides are accepted.
- [x] The Authority Descriptor publishes the agreed versioned endpoints, keys, capabilities, limits, source, policies, privacy terms, and licenses.
- [x] A Relying Service must configure Authority trust independently of discovery.
- [x] Unknown critical capabilities or policy fields fail closed.

## Answer

Challenge creation now requires a backend-only client identifier plus a 32–128 character high-entropy secret. The Authority stores only an HMAC verifier and binds every credential to one deployment environment, Relying Service audience, allowed browser origins, and Action Policy scope. Multiple verifiers for one client support a brief rotation overlap; removing the old verifier retires it without exposing either secret to challenge or discovery responses.

Added immutable Light and Standard Action Policy revisions. Standard permits only an exact expected-hashes override inside its published inclusive bounds; Light permits none, unknown override fields are rejected, and each issued descriptor pins its audience, origins, policy revision, exact Work Requirement, and expiry independently of later requests.

The public Authority Descriptor and JWKS endpoints publish issuer, versioned endpoints, verification keys, algorithms, transports, capabilities, limits, policy defaults and bounds, source/build provenance, operator policy, privacy, terms, and MIT licensing. Relying Service configuration separately requires the trusted issuer and exact Authority keys; discovery cannot add trust. Unknown listed critical capabilities or policy fields fail closed. `bun run verify` passes.
