# Fixed Serial/JTAG implementation map

[Spec](spec.md) and [Ticket 01](issues/01-fixed-serial-worker.md) own the active Gate migration under ADR 0094. Historical USB effort records remain preserved; Core Ticket 23 still requires exact-device firmware evidence.

Current decisions: Controller 0.4; serial 0.1; possession, capability, deployment trust, and lease authorization 0.2; direct foreground Web Serial; 1000 ms heartbeats and 2800 ms device revocation; no automatic resume or compatibility fallback.

## Software completion — 2026-09-04

Ticket 01 is source-complete and verified. The production serial/headless entrypoints and protected acceptance page are ready for the firmware-owned exact-package campaign. Hardware qualification remains open in Core Ticket 23; software conformance does not claim device timing or mining parity.
