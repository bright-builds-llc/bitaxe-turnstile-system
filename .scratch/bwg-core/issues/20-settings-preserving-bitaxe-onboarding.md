# 20: Onboard Bitaxe with settings-preserving Reference Firmware

**What to build:** A first-time Bitaxe owner can enter the reference account-creation journey over USB, safely install compatible signed Reference Firmware when needed, preserve admitted settings, and return to the challenge without an account or mobile app.

**Blocked by:** 11: Protect account creation with an accessible Web Component; 19: Publish the Worker Controller and USB contract with a simulator.

**Status:** ready-for-agent

- [ ] A direct user gesture opens the local USB flow and detects board and firmware capabilities.
- [ ] Firmware manifest signature, digest, board, partition, version, and settings-schema compatibility are verified before flashing.
- [ ] Existing admitted NVS settings are preserved by default.
- [ ] Optional credential-bearing Migration Backup is encrypted in bounded browser memory and downloaded locally only.
- [ ] Unsafe, unknown, or unsupported preservation and recovery conditions stop before flashing.
- [ ] Reboot and rollback behavior preserve a recoverable device state.
- [ ] Post-reboot verification uses redacted categories and hashes before the gate resumes.
- [ ] No Bright Builds Account Identity or mobile application is required.
