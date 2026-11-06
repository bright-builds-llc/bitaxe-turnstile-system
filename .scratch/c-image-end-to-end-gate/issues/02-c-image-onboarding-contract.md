# Agree the C image's onboarding contract

Type: grilling
Status: resolved
Blocked by: None

## Objective

`BitaxeOnboardingDevice` needs `inspect`, `readMigrationSettings`, `flash`,
`reboot` and `verify` from the device, and package admission needs an
`esp32-ota-ab` scheme with mandatory rollback and a settings-schema range. The
C image reports none of these facts, and its `sdkconfig` leaves
`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE` off. The owner decides the contract
before either repository builds it.

## Questions

- [x] Which Worker Serial commands carry inspection, settings read, image write,
  reboot and post-reboot proof, and what bounds each one has.
- [x] Whether the image turns on app rollback, and whether upstream's factory,
  `ota_0` and `ota_1` table counts as `esp32-ota-ab` or needs a new scheme value.
- [x] Which settings-schema number upstream's NVS layout gets, and which keys the
  migration read returns, given the 17-setting `worker-public-settings-c-v1`
  allowlist the image already digests.
- [x] Whether writing goes through upstream's OTA path or the Gate's own writer.
- [x] Whether the new commands change the Worker Serial manifest. If they do, the
  owner's capabilities need new signatures (ADR-0105).

## Answer

Settled by the owner on 2026-11-06.

- **Commands and bounds.** Worker Serial carries only inspection (settings schema,
  partition scheme, active slot, rollback state) and post-reboot proof. Settings
  read, image write and reboot go through the ROM bootloader. Implementers choose
  the bounds, under three rules. Every step has a bounded deadline that ends in
  rollback or a clear error, never a hang. "Device is back" means a fresh Hello
  plus proof of possession on the new image. Tickets 03 and 04 record the values
  they chose, measured on the 601.
- **Rollback and scheme.** The C image turns on
  `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE`. Upstream's table needs a new scheme,
  `esp32-factory-ota-ab`, with `factory` allowed as the active slot.
- **Schema and keys.** Every ESP-Miner build counts as settings schema `1`. The
  owner chose this, since NVS is never written and upstream's boot migrations
  handle older layouts. The migration read is the raw `nvs` partition, not the
  17-setting allowlist. Schema `1` names each category's exact keys: upstream's
  `wifissid`, `wifipass` and the rest for `network`, and `pool` for `pool`. This
  replaces the `wifi_` prefix rule.
- **Writer.** There is one writer: the browser drives the ROM bootloader through
  esptool-js, pinned to an exact version. Upstream's OTA path is not used.
- **Manifest.** The Worker Serial manifest lists transport parameters, not
  commands, so the 205 and 601 capabilities shouldn't need new signatures.
  Ticket 03 confirms the digest stays `a43c2c7d61f95fc6`.

The full contract:

1. **Order.** Ticket 07, the first Gate, runs on a 601 flashed by hand with the C
   reference image, and depends only on 06. Onboarding (03, 04, 05) is proven
   separately, before 09 maps the evidence.
2. **Coverage.** Onboarding covers stock ESP-Miner and reference-to-reference
   updates.
3. **One writer.** The image goes to the inactive OTA slot, and `otadata` is set
   so it boots pending. NVS is never written. The owner's rule for esptool-js:
   replace it with our own ROM client only if a capability we need is missing and
   that is proven, or if our own would be much more useful.
4. **First install, from stock only.** The browser reads the partition table at
   `0x8000`. It proceeds only on upstream's known table or the C table, and
   refuses any other before anything is written. It writes the C bootloader
   (rollback on) and the C partition table (coredump moved to the end of flash)
   once, and reads both back to check them before rebooting.
5. **The C image (Ticket 03).** Marks itself valid only after its own startup
   check (the Gate's link is up and NVS reads back cleanly), instead of
   upstream's unconditional mark-valid in `main/main.c`. The change is offered
   upstream. The image reports the inspection facts over Worker Serial, answers a
   post-reboot verify with category HMACs keyed by a nonce the browser sends, and
   adds no flash-writing command.
6. **Settings.** Before writing, the browser reads the raw `nvs` partition through
   ROM and keeps it as the byte-exact, encrypted, local Migration Backup. It parses
   it in JS for the digests. Every digest is an HMAC keyed by a random
   per-onboarding nonce, never plain SHA-256.
7. **Rollback.** Before mark-valid, the bootloader rolls back on its own. After
   it, the browser drives `rollback()`: it rewrites `otadata` to point at the
   untouched previous slot (often `factory`) and writes the NVS backup back.
   `rollbackState` stays `available` until the user completes onboarding.
8. **Gate contract changes (Ticket 14).** The new scheme with `factory` as an
   active slot, categories defined per schema, nonce-keyed HMAC digests, and the
   parsers, simulator and signed-manifest partition block to match. This needs a
   new ADR, since it changes the signed manifest payload and amends ADR-0046,
   which has plain SHA-256 digests and an optional backup.
9. **Signing.** The owner signs each firmware package manifest (Ticket 05).

## Comments

- The owner's answers came through the coordinating session's grilling, and the
  owner confirmed the whole contract.
- 2026-11-06: point 6's backup is refined in Ticket 14. The rollback copy lives
  in browser memory only, and the encrypted download stays optional.
