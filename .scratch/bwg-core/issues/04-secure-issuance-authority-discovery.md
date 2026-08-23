# 04: Secure challenge issuance and publish Authority discovery

**What to build:** A hosted or self-hosted Relying Service can authenticate to the Gate Authority, select an immutable Action Policy revision, and discover the Authority's public capabilities and trust material without granting trust through discovery itself.

**Blocked by:** 01: Issue the first browser-safe Work Challenge; 03: Prove Gate Pass cryptographic interoperability.

**Status:** ready-for-agent

- [ ] Hosted service credentials are high-entropy, scoped, environment-specific, and safely rotatable.
- [ ] Service credentials are accepted only through the backend interface and never appear in browser data.
- [ ] Action Policy revisions are immutable once a challenge is issued.
- [ ] Only explicitly permitted bounded overrides are accepted.
- [ ] The Authority Descriptor publishes the agreed versioned endpoints, keys, capabilities, limits, source, policies, privacy terms, and licenses.
- [ ] A Relying Service must configure Authority trust independently of discovery.
- [ ] Unknown critical capabilities or policy fields fail closed.
