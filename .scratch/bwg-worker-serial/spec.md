# Fixed Serial/JTAG Worker migration

Status: accepted for implementation, 2026-09-04

The prototype has no compatibility consumers. Replace all active Controller 0.1–0.3 and Worker USB profiles, exports, fixtures, and WebUSB adapters with Controller 0.4 over direct browser Web Serial and fixed ESP32-S3 USB Serial/JTAG. Preserve formal historical ADRs and immutable evidence; their decisions are superseded by ADR 0094. No helper process, TinyUSB production path, automatic reconnection, background mining, or compatibility fallback remains.

The Gate repository owns serial/session/possession/controller/signing contracts, browser adapter, headless composition, and deterministic/browser conformance. Firmware owns USB, production scheduling, revocation, hardware restoration, and exact-package hardware evidence.

## Accepted safety and lifecycle

- Only an explicitly acquired foreground browser session can control the Worker. A browser Web Lock coordinates same-origin ownership and the operating system's exclusive serial open owns the physical port.
- Send heartbeat every 1000 ms. Only a valid advancing peer heartbeat in the admitted current session refreshes liveness. At 2800 ms since the last valid heartbeat firmware atomically revokes work admission and initiates safe stop, reserving 200 ms of a three-second initiation budget. Hardware cooling/restoration completion has a separate bounded evidence deadline.
- Heartbeats never authorize or renew a Work Lease. Existing authenticated Start/Renew and durable per-key anti-replay sequences remain mandatory.
- Hide, page exit, explicit close, read/write failure, protocol violation, device loss, heartbeat expiry, or a new hello invalidates the current session. Best-effort Restore/Close cannot replace device-local revocation. Return to the foreground requires an explicit new session, fresh nonces and possession, confirmed baseline, and new Start authorization.
- The deployment campaign is separately task-gated in firmware. Accepted limits are 400 MHz, 1100 mV, 100% fan, local owner pool inputs, and 180+30+30 seconds of bounded active mining. No Gate implementation action authorizes hardware effects.

## Verification

- Pure serial parsing covers split/coalesced frames, maximum lengths, malformed UTF-8/JSON, unknown fields, wrong session, sequence reuse/overflow, stale heartbeats, and post-revocation responses.
- Browser conformance composes real production adapter code with injected serial/browser boundaries: permission, exclusive ownership, manifest/identity admission, signed possession, headless Start/Renew, foreground loss, restoration failure, cleanup, and explicit fresh restart.
- Cross-repository fixtures publish exact canonical manifest, capability claims, possession transcript/session digest, and full-input lease authorization vectors without private keys or live identity/credential material.
- Required repository checks must pass before commit. Hardware parity remains unverified until firmware's exact-package campaign completes.
