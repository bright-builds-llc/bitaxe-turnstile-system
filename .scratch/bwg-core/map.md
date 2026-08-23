# BWG Core Implementation Map

## Decisions so far

- [Ticket 01](./issues/01-first-work-challenge.md) established the first browser-safe issuance seam: the reference backend owns the opaque Action Reference and selects a versioned Light Action Policy; the browser supplies only its Claimant key and cannot author policy.
- [Ticket 02](./issues/02-exact-work-vectors.md) established canonical target-derived work: assigned targets and Credited Work use fixed-width unsigned big-endian binary, public JSON uses non-zero decimal strings, accumulation is checked, and Equivalent Binary-Zero Work remains display-only.
