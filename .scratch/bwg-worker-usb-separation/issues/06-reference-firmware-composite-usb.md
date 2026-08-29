# 06: Implement the Reference Firmware composite USB adapter

**What to build:** In `bitaxe-esp-miner`, implement the application TinyUSB composite adapter and
volatile Work Lease owner against the published Controller 0.3, Worker USB 0.2, Local Device
Possession, and Work Lease Authorization fixtures plus the exact signed Ultra 205 capability.

**Blocked by:** 05: Publish Worker deployment trust and Work Lease authorization.

**Status:** ready-for-agent

- [ ] The firmware repository records a companion ADR and active task contract covering the exact
  command, device identity, effects, safety, privacy, recovery, cleanup, retry, and stop rules.
- [ ] Reference Firmware generates or loads one persistent Ed25519 Device Identity, keeps its seed
  outside ordinary settings and interfaces, and answers only strict possession-proof challenges.
- [ ] Application firmware exposes a protocol-only vendor-specific WebUSB control function and a
  distinct receive-only CDC evidence function; ROM USB Serial/JTAG remains bootloader/debug-only.
- [ ] Controller requests are parsed into strict domain types, authenticated in full, bounded by
  monotonic deadlines, and supplied transiently to the sole Production Mining Session owner.
- [ ] Firmware provisions only the Work Lease Authority public trust configuration, rejects Update
  Authority keys at the lease-verification interface, and verifies every authorizationless Start
  or Renew field plus the active Challenge binding.
- [ ] Before any Start or Renew effect, firmware atomically advances a dedicated per-authority-key
  authorization-sequence high-water mark outside ordinary settings; non-increasing sequences,
  corruption, or commit uncertainty fail closed across restoration and reboot.
- [ ] Firmware derives the current control-session binding only from the canonical request and
  successfully issued signed possession response/JWK, expires an unused Start context after 60
  local monotonic seconds, retains it for active-lease Renew only, and invalidates it on every
  restoration or continuity-loss path.
- [ ] Challenge authorization and Stratum material remain volatile, never enter ordinary pool/NVS
  settings, and are removed before baseline restoration is confirmed.
- [ ] Pause, Cancel, expiry, disconnect, reboot, monotonic reset, lost continuity, and explicit
  restore stop challenge work locally and restore the captured Mining Baseline.
- [ ] Firmware tests consume the published package fixtures, separate authority trust
  configurations, and exact signed Ultra 205 capability artifact, and prove control/evidence
  isolation, possession-before-lease ordering, 512-byte authorization bounds, full-input and
  control-session authorization, same-nonce/different-identity isolation,
  withheld/cross-session/reboot replay rejection, crash-safe sequence persistence, context expiry,
  safe-stop ordering, credential redaction, and deterministic failure categories.
- [ ] A software-only package and real-process host conformance run pass before any hardware effect.

## Answer

Pending.
