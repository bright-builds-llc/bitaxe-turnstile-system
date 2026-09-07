# Fixed Serial/JTAG implementation map

[Spec](spec.md) and [Ticket 01](issues/01-fixed-serial-worker.md) own the active Gate migration under ADR 0094. Historical USB effort records remain preserved; Core Ticket 23 still requires exact-device firmware evidence.

Current decisions: Controller 0.4; serial 0.2; possession, capability, deployment trust, and lease authorization 0.2; direct foreground Web Serial; 1000 ms heartbeats and 2800 ms device revocation; no automatic resume or compatibility fallback.

## Software completion — 2026-09-04

Ticket 01 is source-complete and verified. The production serial/headless entrypoints and protected acceptance page are ready for the firmware-owned exact-package campaign. Hardware qualification remains open in Core Ticket 23; software conformance does not claim device timing or mining parity.

## Decisions so far

[Ticket 09](issues/09-admission-diagnostics-budget-review.md) and ADR 0097 add
closed admission diagnostics, possessed-session ledger review and an explicitly
invalid-signature recovery test. A firmware-owned successor may use only the
original unreserved campaign windows; prior failed windows are never promoted
or refunded. Gate software is verified; exact-device acceptance remains open.

[Ticket 10](issues/10-final-window-cooling-proof.md) and ADR 0098 add fan-only
qualification and typed Start rejection preservation. The last-window
successor requires successful cooling/restoration and unchanged ledger evidence;
original failed normal and foreground-loss windows remain unverified.

[Ticket 11](issues/11-iterative-attempts-and-panic-receipts.md) and ADR 0099
separate new individually bounded diagnostic/acceptance attempts from the
immutable original campaign. Signed purpose/ordinal metadata, manifest support,
a separate durable ledger review and explicit closed diagnostic export preserve
authorization, accounting and crash evidence. Firmware still owns physical proof.

[Ticket 12](issues/12-retain-allocation-crash-receipts.md) reserves allocation
failure/context observations alongside existing crash receipts. Saturation and
reconnect tests preserve them within the unchanged 40-observation export bound;
this changes no manifest, signing contract or firmware behavior.

[Ticket 13](issues/13-enforce-worker-owner-stack-headroom.md) adds optional
owner-resource telemetry and the iterative 4096-byte active headroom requirement.
A failed snapshot survives cleanup; firmware freshness and the targeted stack
correction require new physical evidence. Legacy campaigns remain unchanged.
