# 02: Standardize exact work encoding and vectors

**What to build:** A canonical, independently checkable representation of target-derived Credited Work that every BWG role can share without floating-point drift. This prefactor makes later progress, persistence, and conformance slices implement one invariant rather than inventing arithmetic locally.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Credited Work follows the accepted target-to-work formula for valid 256-bit targets.
- [ ] Invalid, zero, boundary, and overflow cases have explicit outcomes.
- [ ] JSON and fixed-width binary representations round-trip without loss.
- [ ] Equivalent Binary-Zero Work is derived for display without becoming authoritative accounting.
- [ ] Canonical vectors include difficulty-1, preset, fractional-display, and accumulation examples.
- [ ] Expected values come from independent worked sources rather than the implementation under test.
- [ ] Other roles can consume the vectors without importing Gate Authority implementation details.
