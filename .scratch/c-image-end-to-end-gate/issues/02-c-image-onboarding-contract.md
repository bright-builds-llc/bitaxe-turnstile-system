# Agree the C image's onboarding contract

Type: grilling
Status: ready-for-human
Blocked by: None

## Objective

`BitaxeOnboardingDevice` needs `inspect`, `readMigrationSettings`, `flash`,
`reboot` and `verify` from the device, and package admission needs an
`esp32-ota-ab` scheme with mandatory rollback and a settings-schema range. The
C image reports none of these facts, and its `sdkconfig` leaves
`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE` off. The owner decides the contract
before either repository builds it.

## Questions

- [ ] Which Worker Serial commands carry inspection, settings read, image write,
  reboot and post-reboot proof, and what bounds each one has.
- [ ] Whether the image turns on app rollback, and whether upstream's factory,
  `ota_0` and `ota_1` table counts as `esp32-ota-ab` or needs a new scheme value.
- [ ] Which settings-schema number upstream's NVS layout gets, and which keys the
  migration read returns, given the 17-setting `worker-public-settings-c-v1`
  allowlist the image already digests.
- [ ] Whether writing goes through upstream's OTA path or the Gate's own writer.
- [ ] Whether the new commands change the Worker Serial manifest. If they do, the
  owner's capabilities need new signatures (ADR-0105).

## Comments
