# 12: Retain allocation crash receipts across reconnects

Status: resolved
Blocked by: None
Type: task

- [x] Reproduce allocation receipt loss after normal diagnostic saturation.
- [x] Reserve allocation failure/context records with stable closed keys.
- [x] Verify reconnect retention and the existing 40-observation export bound.
- [x] Pass required publication checks and publish the unchanged-manifest fix.

## Context

Ticket 11 reserved prior-boot preparation and panic receipts, but allocation
failure/context records still occupied the normal diagnostic map. Saturation
could drop them, and reconnect reset erased them. This follow-up changes only
bounded diagnostic retention; it adds no authority or fabricated boot identity.

## Answer

Allocation failure and context records now use the existing eight reserved
crash slots. Stable closed keys deduplicate them without inventing boot identity.
Normal diagnostic saturation and reconnect reset cannot erase retained records;
the combined export remains bounded at 40 observations.

Two regression tests failed before the fix and pass afterward. Full repository
verification passed, including ordered Rust checks, TypeScript, 396 web/CLI tests,
browser conformance, lookup vectors, package builds/exports and standards. The
manifest, signing contracts and firmware behavior are unchanged. No hardware
activity occurred during this follow-up.
