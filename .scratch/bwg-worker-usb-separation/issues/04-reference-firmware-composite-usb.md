# 04: Implement the Reference Firmware composite USB adapter

**What to build:** In `bitaxe-esp-miner`, implement the application TinyUSB composite adapter and
volatile Work Lease owner against the published Controller 0.2 and USB fixtures.

**Blocked by:** 02: Prototype and publish Controller 0.2 transport fixtures.

**Status:** ready-for-agent

- [ ] The firmware repository records a companion ADR and active task contract covering the exact
  command, device identity, effects, safety, privacy, recovery, cleanup, retry, and stop rules.
- [ ] Application firmware exposes a protocol-only vendor-specific WebUSB control function and a
  distinct receive-only CDC evidence function; ROM USB Serial/JTAG remains bootloader/debug-only.
- [ ] Controller requests are parsed into strict domain types, authenticated in full, bounded by
  monotonic deadlines, and supplied transiently to the sole Production Mining Session owner.
- [ ] Challenge authorization and Stratum material remain volatile, never enter ordinary pool/NVS
  settings, and are removed before baseline restoration is confirmed.
- [ ] Pause, Cancel, expiry, disconnect, reboot, monotonic reset, lost continuity, and explicit
  restore stop challenge work locally and restore the captured Mining Baseline.
- [ ] Firmware tests consume the published package fixtures and prove control/evidence isolation,
  safe-stop ordering, credential redaction, and deterministic failure categories.
- [ ] A software-only package and real-process host conformance run pass before any hardware effect.

## Answer

Pending.
