# 11: Bind iterative qualification attempts and preserve panic receipts

Status: resolved
Blocked by: None
Type: task

- [x] Add mutually exclusive signed qualificationAttempt metadata and manifest support.
- [x] Preserve legacy authorization vectors and the original campaign's ledger meanings.
- [x] Validate independent attempt ledger and telemetry observations.
- [x] Retain previous-boot preparation receipts separately from current diagnostics.
- [x] Export only validated closed diagnostics through an explicit local operation.
- [x] Run diagnostic, normal and fault purposes through the actual browser composition.
- [x] Verify schemas, signing vectors, parser boundaries, browser lifecycle and full repository checks.

## Context

Owner-approved iterative diagnosis follows the failed original 240000-ms campaign.
New attempts have separate durable ordinals and bounded signed purposes. The
original failed attempts, reservations and evidence remain immutable. The firmware
owns physical safety, crash recovery and hardware evidence. Gate owns signed
contracts, direct Web Serial composition and privacy-safe observation.

## Comments

ADR 0099 defines the successor contract. No hardware or production signing input
is required for software verification. Publishing requires coordinated firmware
manifest/capability identity and repository verification; software outcomes cannot
promote failed hardware acceptance.

## Answer

Implemented the signed exclusive attempt metadata, separate ledger/telemetry,
manifest binding, purpose-aware production browser path, and validated diagnostic
export with previous-boot retention. Public RFC 8032 vectors cover all four
purposes; the firmware repository independently verified them and tampering.

Verification passed: ordered Rust format/clippy/build/tests, TypeScript,
394 web/CLI tests, real browser conformance, lookup vectors, package export/build
checks and standards. An initial strict-schema compilation failure in the new
mutual-exclusion clause was corrected; affected schemas and every remaining
verification phase passed. The final typed preparation failure/step grammar and
iterative cooling boundaries have dedicated passing regressions. Hardware effects,
physical panic diagnosis and real-mining acceptance remain firmware-owned and
unverified by this software ticket. The original campaign ledger is unchanged.
