# Cadence stage diagnostics v2

Type: task
Status: resolved
Blocked by: None

## Objective

Read the firmware-owned v2 cadence diagnostics for the next guarded qualification
without changing authority, safety deadlines or acceptance criteria. Preserve
strict historical v1 parsing and retain explicit failed-clock diagnostic data.

## Plan

- [x] Add a discriminated v1/v2 review type and fixed eleven-stage timing arrays.
- [x] Reject missing, extra, malformed and unsafe numeric v2 fields; keep v1 unchanged.
- [x] Verify parsers, production-controller export and existing cadence regressions.
- [x] Coordinate producer confirmation, full checks and exact clean publication.

## Comments

2026-09-14: The parent firmware task owns ordinal selection, new v2 context
requirements, instrumentation and hardware effects. Gate only preserves the
closed metadata response. Global and repository active lessons remain 9,369 bytes
and were read completely. No historical evidence or accepted criteria change.

The producer confirmed and froze the v2 field names and stage ordering. Gate
uses a schema-discriminated review type and closed shape-only parsing, preserving
explicit failed-clock data rather than imposing a second qualification judge.
V1 remains unchanged and cannot silently acquire or accept v2 fields. Focused
coverage includes the real possessed controller, historical v1, invalid/unsafe
numbers, wrong keys and lengths, sparse arrays, and independent stage maxima.

## Answer

Full canonical verification passed: ordered format/Clippy/build/Rust tests
(352 passed; two existing opt-in tests ignored), 567 web/crypto tests with
1569 expectations, browser conformance, lookup vectors, package verification
and standards. Scoped Markdown checks used the installed GFM/frontmatter
extensions. Logs are retained under `artifacts/cadence-v2-voYlzW/`.

The change is limited to versioned diagnostic parsing/types, fixtures and
protocol documentation. No hardware effects, new grants, budget changes,
safety/heartbeat changes or retrospective evidence promotion originate here.
The firmware owner binds the published Gate build to its prospective v2 context.
