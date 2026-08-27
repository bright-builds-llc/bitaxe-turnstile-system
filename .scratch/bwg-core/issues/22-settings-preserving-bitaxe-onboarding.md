# 22: Onboard Bitaxe with settings-preserving Reference Firmware

**What to build:** A first-time Bitaxe owner can enter the reference account-creation journey over USB, safely install compatible signed Reference Firmware when needed, preserve admitted settings, and return to the challenge without an account or mobile app.

**Blocked by:** 13: Protect account creation with an accessible Web Component; 21: Publish the Worker Controller and USB contract with a simulator.

**Status:** resolved

- [x] A direct user gesture opens the local USB flow and detects board and firmware capabilities.
- [x] Firmware manifest signature, digest, board, partition, version, and settings-schema compatibility are verified before flashing.
- [x] Existing admitted NVS settings are preserved by default.
- [x] Optional credential-bearing Migration Backup is encrypted in bounded browser memory and downloaded locally only.
- [x] Unsafe, unknown, or unsupported preservation and recovery conditions stop before flashing.
- [x] Reboot and rollback behavior preserve a recoverable device state.
- [x] Post-reboot verification uses redacted categories and hashes before the gate resumes.
- [x] No Bright Builds Account Identity or mobile application is required.

## Answer

The public `bwg-core/bitaxe-onboarding` state machine performs no device access until explicit
`connect()`. The accessible Web Component exposes that seam only through a visible “Connect Bitaxe
over USB” fallback button and reloads the gate session after onboarding succeeds. Inspection reads
only strict Worker Controller capabilities, settings-schema version/readability, and A/B
partition/rollback facts; already-compatible Reference Firmware proceeds without flashing.

Firmware admission verifies a uniquely trusted Ed25519 Update Authority compact signature over the
canonical manifest, exact image SHA-256, semantic version, board/revision allowlist, A/B partition
requirements, mandatory rollback, settings-schema range/target, image bounds, and HTTPS source.
Unknown fields, private keys, signature/payload/image drift, unreadable or oversized settings, and
unsupported board/partition/schema/recovery conditions stop before flash.

Admitted settings are copied by default within a 65,536-byte browser bound and the migration buffer
is wiped on every exit. Optional local backup uses random-salt PBKDF2-SHA256 and AES-256-GCM, is
handed only to a local-download callback, and is proven decryptable with the user material. The
browser derives a complete-settings digest plus redacted `network`/`pool` hashes and requires the
post-reboot device inspection and strict proof to agree on firmware, schema, active slot,
bootability, rollback state, and every hash. Interrupted flash or verification mismatch rolls back,
reboots, and must reproduce the original safe state before returning a recoverable result. The
deterministic simulator and real Chromium component journey cover production success and
fail-closed paths without any account or mobile-app dependency.
