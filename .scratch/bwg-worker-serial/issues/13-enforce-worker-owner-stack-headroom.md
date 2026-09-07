# 13: Enforce observed Worker owner stack headroom

Status: resolved
Blocked by: None
Type: task

- [x] Validate optional, closed, generation-bound owner-resource telemetry.
- [x] Fail iterative running qualification when active owner headroom is missing or below 4096 bytes.
- [x] Preserve legacy behavior and retain failed observations for judgment.
- [x] Verify parsers, qualification enforcement and required publication checks.

## Context

Diagnostic ordinal 1 dispatched one work item, accumulated 7359 active milliseconds
and stopped safely without a panic, but the 16384-byte owner stack's lifetime
high-water observation left only 28 bytes. This does not establish the prior panic's
cause. Firmware is qualifying a targeted 24576-byte stack and fresh resource
observations before a longer run. Harness version 2 requires at least 4096 bytes
of measured headroom; prior contexts and judgments remain unchanged.

## Answer

The strict optional telemetry parser enforces closed fields, u32 resources,
canonical u64 timestamp strings and the enclosing generation. Iterative Start,
refresh and fault preparation require active-phase evidence with at least 4096
stack bytes. Failure records an immutable closed snapshot and preserves the
original window_control_failed cause while closure status and ownership still
report cleanup failures. Legacy grants do not acquire this requirement.

Full repository verification passed: ordered Rust checks, TypeScript, 400
web/CLI tests, browser conformance, lookup vectors, package builds/exports and
standards. Focused tests cover missing resources, 28/4095-byte rejection,
4096-byte admission, wrong generation/type/phase, and immutable failure retention.
No manifest or signing change and no hardware effects occurred in this Gate task.
The targeted firmware stack size still requires fresh physical qualification;
the earlier panic cause remains unproven.
