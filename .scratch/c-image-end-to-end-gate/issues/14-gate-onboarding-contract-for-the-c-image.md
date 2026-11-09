# Gate onboarding contract matches the C image

Type: task
Status: resolved
Blocked by: 02

## Objective

Change this repository's onboarding contract to Ticket 02's decisions, so the C
image (03) and the browser installer (04) build against one versioned contract
and shared vectors. Contract and tests only; no ROM client and no firmware.

## Plan

- [x] A new ADR recording Ticket 02: one ROM writer, the first-install
  bootloader and table write, `esp32-factory-ota-ab`, per-schema categories,
  nonce-keyed HMAC digests, browser-driven rollback after mark-valid, and the
  rollback copy below. It amends ADR-0046 and says whether
  `bwg-reference-firmware/0.1` keeps its identifier.
- [x] The raw NVS copy for rollback lives only in browser memory while onboarding
  runs, as a bounded plaintext buffer like today's. It is wiped when the user
  completes onboarding or anything fails, and never reaches browser storage.
- [x] The passphrase-encrypted Migration Backup download (ADR-0046) stays
  optional, and is offered prominently for a first install from stock. If the tab
  closes first, the device keeps the C image, which has passed its startup check,
  and a later rollback needs that download.
- [x] `rollbackState` is `available` only while the in-memory copy exists, or when
  the user supplies the download.
- [x] The manifest's partition block and the snapshot and verify parsers accept
  `esp32-factory-ota-ab`, with `factory` as an active slot, and refuse any other
  scheme.
- [x] Schema `1` names each category's exact keys from upstream's
  `main/nvs_config.c`, replacing the `wifi_` prefix rule.
- [x] Verify sends a random per-onboarding nonce, and every category digest is an
  HMAC under it. Parsers refuse a plain SHA-256 digest or a reply under another
  nonce.
- [x] Simulator, browser conformance fixture and protocol doc updated, with
  vectors the C image's host tests can reuse. `bun run verify` passes.

## Answer

Done on 2026-11-08 in ADR-0111, which amends ADR-0046. The contract and tests only: no
ROM client, NVS parser or firmware.

- **Versions.** The signed manifest's profile is now `bwg-reference-firmware/0.2`; `0.1`
  is refused. No `0.1` manifest was signed for a release, so nothing in use breaks. The
  settings digest encoding is `bwg-settings-hmac/1`, and the shared vectors live in
  `conformance/bwg-bitaxe-onboarding-0.2/settings-hmac-vectors.json`, published as
  `bwg-core/bitaxe-onboarding-conformance/settings-hmac-vectors`.
- **Scheme.** Manifest, snapshot and verify parsers accept only `esp32-factory-ota-ab`,
  with `factory`, `ota_0` or `ota_1` active. An install writes `ota_0`, or `ota_1` from
  `ota_0`, never `factory`.
- **Schema 1 keys** (`web/bitaxe-settings-hmac.ts`), in the `main` namespace:
  `network` is `wifissid`, `wifipass`, `hostname`, `usentp`; `pool` is `pool_1` to
  `pool_8`, `prim_idx`, `sec_idx`, `usefbstartum`; `all` is every key of upstream's
  settings table plus `asicfrequency` and `fanspeed`, except values the firmware changes
  itself (`last_fw_fp`, `use_custom_www`, `bestdiff`, `total_uptime`, `cum_hashes_hi`,
  `cum_hashes_lo`, `scoreboard_*`).
- **HMACs.** Each onboarding draws a random 32-byte nonce. `verifyRedactedSettings(nonce)`
  replies with `nonce` echoed and `{ category, hmacSha256 }` per category; the parser
  refuses `digestSha256`, a missing or other nonce, and the old device-reported
  `rollbackState`. The returned evidence leaves the nonce out. The encoding is in
  `docs/protocol/bwg-0.1-bitaxe-onboarding.md`.
- **Device seam.** `readMigrationSettings` returns `{ nvsPartition, entries }`: the raw
  partition and its decoded `main` entries (`{ key, type, value }`, ESP-IDF type names,
  integers as decimal strings, blobs as base64url). `flash` takes a `targetSlot` and no
  settings, and `rollback` takes `{ slot, nvsPartition }`.
- **Rollback copy.** `BitaxeOnboarding` gains `rollbackState()`, `complete()` and
  `rollBack()`. The raw partition stays in memory after a `ready` install, so
  `rollbackState()` is `available`; `complete()`, any failure and any rollback wipe it.
  After that it is `backup_required` if the user downloaded a Migration Backup, and
  `rollBack({ maybeMigrationBackup })` restores from the download, checked against the
  HMACs the install kept. Inspection returns `migrationBackup: "recommended"` for a
  first install from stock.
- **Vectors.** `scripts/generate-bitaxe-settings-hmac-vectors.mjs` regenerates them with
  `node:crypto` and no code from `web/`, so the TypeScript module is checked against a
  second implementation. They hold each message in hex and its HMAC for five cases, nine
  refused entry lists, and accepted and refused verification replies. Ticket 03's host
  tests can reuse them as they are.

Decided here, not by the owner: the exact `all` exclusions, and `prim_idx`, `sec_idx`
and `usefbstartum` joining `pool` (Ticket 02 named only `pool`). The binary encoding
and the profile bump are this ticket's own choices too.

Left open, recorded in ADR-0111 for Ticket 04: how the browser inspects stock, which has
no Worker Serial, and checks a rollback to it, since `rollBack()` still asks the restored
image to verify; and a rollback from the download in a later page, which needs the
browser's NVS parser. A stock build older than the C image's layout runs upstream's boot
migrations, which change the HMACs, so its onboarding rolls back safely and needs a stock
update first.

## Comments

- 2026-11-06: the owner chose "Memory, download optional" for how the rollback
  copy is kept.
