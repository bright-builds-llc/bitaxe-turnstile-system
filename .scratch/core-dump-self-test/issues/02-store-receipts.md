# task-core-dump-store-receipts | 2026-09-27 | Typed store diagnostics

Status: resolved
Blocked by: None

Consume the firmware-owned, closed `core_dump_store_receipt schema=v1` marker
without granting hardware authority or exposing panic strings or memory contents.
Source fingerprints and boot counters remain diagnostic correlation fields;
exact installed ELF identity is proved separately by authenticated admission.

- [x] Add exact valid and invalid-status grammars with bounded integer fields.
- [x] Preserve current and previous observations with origin/source/boot keys.
- [x] Test the native diagnostic/export boundary and retention across reconnects.
- [x] Run repository verification, review the diff and publish the Gate bundle.

No hardware, firmware edits, core capture or parity qualification occurs here.

## Answer

Added the strict core-store receipt parser and export revalidation. Current
progress and previous receipts have separate origin/source/boot identities;
previous evidence survives ordinary reconnect clearing. Existing 32-observation
and eight-crash limits remain unchanged. No raw messages or memory are exported.

`bun run verify` passed, including Rust checks, 824 web/conformance tests, browser
conformance, package verification and standards. The 25 new focused cases pass,
including the firmware renderer's exact ready marker, integer bounds, absence
versus negative errors, history identity and fragmented native framing. Final
typecheck, Markdown and diff checks passed. Hardware/store/capture results and
full ELF identity remain obligations of the firmware-owned diagnostic contract.
