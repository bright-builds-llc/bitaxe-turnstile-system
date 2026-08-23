# 02: Standardize exact work encoding and vectors

**What to build:** A canonical, independently checkable representation of target-derived Credited Work that every BWG role can share without floating-point drift. This prefactor makes later progress, persistence, and conformance slices implement one invariant rather than inventing arithmetic locally.

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] Credited Work follows the accepted target-to-work formula for valid 256-bit targets.
- [x] Invalid, zero, boundary, and overflow cases have explicit outcomes.
- [x] JSON and fixed-width binary representations round-trip without loss.
- [x] Equivalent Binary-Zero Work is derived for display without becoming authoritative accounting.
- [x] Canonical vectors include difficulty-1, preset, fractional-display, and accumulation examples.
- [x] Expected values come from independent worked sources rather than the implementation under test.
- [x] Other roles can consume the vectors without importing Gate Authority implementation details.

## Answer

Added a public pure `work` module that parses non-zero 256-bit assigned targets, calculates Credited Work as `floor(2^256 / (target + 1))`, and exposes exact checked accumulation. Credited Work uses a canonical non-zero decimal string in JSON and a 32-byte unsigned big-endian binary representation; invalid widths, zero values, out-of-range decimals, boundary targets, and accumulation overflow all have explicit errors.

Equivalent Binary-Zero Work is derived separately as the non-authoritative base-2 logarithm of exact Credited Work. The portable `BWG/0.1` fixture covers the Bitcoin difficulty-1 target, the Light preset, fractional display, minimum and maximum targets, exact accumulation, and negative cases. Its independent sources pin the accepted ADR and the Bitcoin Core implementation used to check the worked values. Unit tests and the public conformance harness exercise the fixture without importing Gate Authority implementation details, and `bun run verify` passes.
