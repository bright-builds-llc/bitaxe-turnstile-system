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

[Ticket 14](issues/14-signed-pool-difficulty-hint.md) is resolved following exact-pair
firmware consumption and bounded owner-pool acceptance on 2026-09-08: correlated
accepted shares, signed renewal, foreground-loss and heartbeat-loss shutdown
initiation within three seconds. [Core Ticket 23](../bwg-core/issues/23-real-bitaxe-restoration-evidence.md)
retains its broader BIP 23/restoration blockers; stale-frame recovery remains a
separate bounded-drain limitation, not seamless reconnection evidence.

[Ticket 15](issues/15-fresh-hello-resynchronization.md) owns bounded fresh-Hello
resynchronization over complete stale device output. Firmware owns the separate
no-mining hardware contract and four-cycle qualification for the changed pair.

[Ticket 16](issues/16-correlated-recovery-traces.md) adds bounded browser/device
trace export, precise pending-promise receipts and a one-use diagnostic loss
phase without graceful wire writes. Software gates pass; firmware owns the
separate loss/resume hardware contract, retained shutdown and accounting proof.
