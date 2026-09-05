# 05: Diagnose receive loss and storage/HTTP startup failures

**Status:** resolved
**Blocked by:** None

- [x] Verify actual received request padding length in maximum probes.
- [x] Accept only closed receive and storage/HTTP phase/outcome diagnostics.
- [x] Run required checks and publish for the paired firmware pin.

## Context

Firmware attempt-005 reached exact stable application execution and browser possession, but startup reported storage_http failure and the maximum exchange lost liveness. A subsequent passive capture retained no TX failure. Preserve this evidence and deadlines; add receive-stage and precise service failure observations before resource tuning. Probe response extension must not conceal lost request padding.

## Verification

New cross-language exact-bound regressions failed before the received-length response was added. Hardware success remains unverified; this change adds diagnostic evidence and strengthens the test oracle.

## Review

Full format and verification pass: Rust lint/build/tests, TypeScript, 299 web/CLI tests, browser conformance, package and standards checks. Received-length mismatch and both exact payload bounds are covered. Diagnostics remain closed, local and non-authoritative. Firmware review also corrected clean-close classification and revoked partial-input cleanup. Physical startup health, maximum exchange success and cycle/mining qualification remain pending in the firmware task.
