# C image reports onboarding facts and guards its own boot

Type: task
Status: ready-for-human
Blocked by: 02, 14

## Objective

Implement the C image's half of Ticket 02's contract in `bitaxe-esp-miner-c`,
against Ticket 14's vectors. The work and its tests land in that repository under
its own rules (host tests, upstream hooks listed in its `AGENTS.md`). This ticket
records the result and the commit. The image adds no flash-writing command; the
browser writes through the ROM bootloader (Ticket 04).

## Plan

- [ ] Firmware ticket opened in the C repository and linked here.
- [x] `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE` on. The image marks itself valid only
  after its startup check (the Gate's link is up and NVS reads back cleanly),
  replacing upstream's unconditional mark-valid in `main/main.c`. A host or QEMU
  test shows a failed check rolling back.
- [x] The C partition table moves coredump to the end of flash.
- [x] Inspection over Worker Serial: settings schema `1`, partition scheme, active
  slot and rollback state.
- [x] Post-reboot verify answers with category HMACs keyed by the browser's nonce,
  passing Ticket 14's vectors.
- [ ] Bounds chosen under Ticket 02's rules and measured on the 601, recorded here.
- [x] The Worker Serial manifest digest confirmed as `a43c2c7d61f95fc6`, so the 205
  and 601 capabilities need no new signatures.
- [x] The mark-valid change prepared as an upstream offer; the owner opens it.

## Answer

Built on 2026-11-09 in `bitaxe-esp-miner-c` commit `51e5af9`, now on its `master` and
pushed. The bounds are chosen but not yet measured on
the 601, so this ticket waits for a hardware sitting with the owner. Nothing was flashed.

- **Commands.** Worker Serial has two read-only controller commands. Neither needs admission,
  like `discover`, and both answer during a lease. An HMAC under a host-chosen nonce gives
  nothing that the USB port doesn't already give through ROM. Replies arrive in the usual
  `result` envelope.
  - `onboarding_inspect` takes no payload. It replies with the snapshot without
    `capabilities`, which the browser takes from `discover`:
    `{settingsSchemaVersion: 1, settingsReadable, partition: {scheme, appSlotBytes,
    rollbackAvailable, activeSlot, bootable}}`.
  - `onboarding_verify` takes `{nonce}`, canonical unpadded base64url of 32 bytes. It replies
    with exactly the seven fields `parseVerification` accepts. Unreadable settings are refused
    with `persistence_failed` and give no HMAC.
- **Fact meanings.**
  - `scheme` is `esp32-factory-ota-ab` when the table has `factory`, `ota_0`, `ota_1` and
    `otadata`, and `unknown` otherwise.
  - `appSlotBytes` is the smaller of `ota_0` and `ota_1`.
  - `bootable` means the running image is `VALID`, or `factory` with no otadata state. A pending
    image is not.
  - `rollbackAvailable` is `esp_ota_check_rollback_is_possible()`.
  - `settingsReadable` means every schema-1 `all` key reads without an error other than
    not-found.
  - `preservationConfirmed` is `bootable`, since an unreadable namespace gives no reply at all.
  - `runningFirmwareVersion` is the signed capability's `firmware.version`.
- **Startup check.** `main/bwg/bwg_mark_valid.c` replaces upstream's mark-valid at the same
  place in `main/main.c`. An image in state `PENDING_VERIFY`, or `NEW` under an older
  bootloader, is marked valid once every schema-1 key reads back. Where the Gate is provisioned
  for the board and the boot isn't a self-test, it also waits for the Gate link to be up.
  - Unreadable settings roll back at once. A link that isn't up 120 s after boot rolls back
    then, through `esp_ota_mark_app_invalid_rollback_and_reboot()`.
  - A reset before the check rolls back through the bootloader.
  - 120 s is provisional. The C image starts its link only after Wi-Fi, the NTP wait (up to
    32 s) and ASIC initialization, so an image that can't reach Wi-Fi, or whose cold ASIC
    initialization fails, rolls back.
  - The verdict is `proto/bwg_boot_check.c`, and host tests show a failed check rolling back.
    A real bootloader rollback is left for the 601.
- **HMACs.** `proto/bwg_settings_hmac.c` streams the `bwg-settings-hmac/1` message into
  HMAC-SHA-256. Host tests hold its key lists to `schemas.1` and check each of the five
  vectors' `messageHex` bytes and HMACs. They also rebuild the `stock-settings-on-ota_0`
  accepted reply byte for byte, and fail if a pool value is left in freed memory.
- **Manifest.** Unchanged. `BWG_SERIAL_MANIFEST_SHA256` is `a43c2c7d61f95fc6…` in hex, and a
  host test asserts it.
- **Upstream offer.** It is on the local branch `offer/mark-valid-after-startup`, one commit
  on `upstream/master` `bcb569f`, not pushed and not built. That commit turns rollback on and
  marks valid after the REST server starts. The draft issue is in the C repository's
  `docs/project/upstream-candidates.md`, and the owner opens it (`task-upstream-mark-valid`).
- **Checks.** `bash tools/run_bwg_host_tests.sh` (679 passed, plain and sanitized),
  `bun scripts/bright-builds-check.ts all` (0 findings) and `idf.py build`, an unprovisioned
  build at 2,983,632 bytes with 29% of the slot free and rollback on.
- **Left open.** No firmware ticket was opened in the C repository's GitHub. The work is
  tracked in its `TASKS.md` (`task-onboarding-bounds-601`). The 601 sitting measures the
  deadline against a real boot, a failed check rolling back through the bootloader, and the
  HMACs over its NVS. A board flashed with this build gets the rollback bootloader. A board
  running from `factory` is never on trial, so the check leaves it alone. Which slot the 205
  and 601 run from wasn't checked.

## Comments
