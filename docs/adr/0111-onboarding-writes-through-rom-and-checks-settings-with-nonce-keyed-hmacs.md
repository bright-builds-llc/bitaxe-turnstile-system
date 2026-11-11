# ADR-0111: Onboarding writes through ROM and checks settings with nonce-keyed HMACs

Accepted 2026-11-08. It records the owner's decisions of 2026-11-06 (Ticket 02 of
`.scratch/c-image-end-to-end-gate`) as Ticket 14 built them into the Gate's onboarding
contract. It amends ADR-0046: settings digests are no longer plain SHA-256, and the
rollback copy is kept in browser memory. The Migration Backup stays optional, local and
encrypted, as ADR-0046 says.

ADR-0112 (proposed 2026-11-11, Ticket 04) settles the consequences below that were left to
Ticket 04, and adds the C bootloader and table digests to the signed `0.2` manifest.

Onboarding installs the C Reference Firmware image (ADR-0105) on a Bitaxe from stock
ESP-Miner or from an earlier reference image, and keeps the board's settings. The C image
reported none of the facts onboarding needed, upstream's partition table fits no scheme
the Gate accepted, and the old category digests were plain SHA-256 over a JSON settings
record that ESP-Miner doesn't have.

From now on:

- **One writer.** The browser drives the ESP32-S3 ROM bootloader through esptool-js,
  pinned to an exact version. Upstream's OTA path is not used, and the C image adds no
  flash-writing command. Worker Serial carries only inspection (settings schema, partition
  scheme, active slot, rollback state) and the post-reboot proof. We replace esptool-js with
  our own ROM client only if a capability we need is proven missing, or if our own would be
  much more useful.
- **First install, from stock only.** The browser reads the partition table at `0x8000`
  and proceeds only on upstream's known table or the C table, refusing any other before
  anything is written. It writes the C bootloader (app rollback on) and the C table
  (coredump moved to the end of flash) once, and reads both back before rebooting.
- **Scheme `esp32-factory-ota-ab`.** Upstream's and the C image's tables have `factory`,
  `ota_0` and `ota_1`. `factory` may be the active slot. An install writes `ota_0`, or
  `ota_1` when `ota_0` is running, never `factory`, and sets `otadata` so the image boots
  pending. NVS is never written, except to restore the rollback copy. The manifest's
  partition block and the snapshot and verify parsers accept this scheme and refuse any
  other, including `esp32-ota-ab`.
- **Settings schema `1`.** Every ESP-Miner build is schema `1`; upstream's boot migrations
  handle older layouts. The migration read is the raw `nvs` partition, not the C image's
  17-setting allowlist. Schema `1` names each category's exact keys in the `main`
  namespace, from upstream's `main/nvs_config.c`, replacing the `wifi_` prefix rule:
  - `network`: `wifissid`, `wifipass`, `hostname`, `usentp`;
  - `pool`: `pool_1` to `pool_8`, `prim_idx`, `sec_idx`, `usefbstartum`;
  - `all`: every key in that file's settings table plus its two downgrade fallback keys
    (`asicfrequency`, `fanspeed`), except values the firmware changes itself across a
    reboot or a firmware change: `last_fw_fp`, `use_custom_www`, `bestdiff`,
    `total_uptime`, `cum_hashes_hi`, `cum_hashes_lo` and `scoreboard_01` to
    `scoreboard_20`.
- **Nonce-keyed HMACs.** The browser picks a random 32-byte nonce per onboarding and sends
  it with each verify. Every category digest is HMAC-SHA-256 under that nonce over the
  `bwg-settings-hmac/1` encoding of the category's present entries. The reply echoes the
  nonce, and the parsers refuse a plain SHA-256 digest or a reply under another nonce. The
  nonce goes only to the device; the evidence onboarding returns leaves it out. A plain
  digest of a Wi-Fi passphrase can be guessed offline, and one reply could be replayed in
  a later onboarding.
- **Rollback.** Before mark-valid, the C bootloader rolls back on its own; the C image
  marks itself valid only after its own startup check (Ticket 03). After mark-valid, the
  browser drives rollback: it points `otadata` at the untouched previous slot (often
  `factory`) and writes the `nvs` copy back.
- **The rollback copy.** The raw `nvs` partition lives only in browser memory while
  onboarding runs, as a bounded plaintext buffer of at most 65,536 bytes. It is wiped when
  the user completes onboarding, when anything fails, and after a rollback. It never
  reaches browser storage. `rollbackState` is `available` only while that copy exists; once
  it is wiped, a rollback needs the user's Migration Backup download (`backup_required`).
- **The Migration Backup.** The passphrase-encrypted download stays optional, and
  inspection marks it `recommended` for a first install from stock. If the tab closes first,
  the device keeps the C image, which has passed its startup check, and a later rollback
  needs that download.
- **Profile `bwg-reference-firmware/0.2`.** The signed manifest payload changed, so its
  profile identifier moves from `0.1` to `0.2`, and `0.1` manifests are refused. No `0.1`
  manifest was ever signed for a release (Ticket 05 signs the first), so nothing in use is
  invalidated. The Worker Serial manifest doesn't change, so the owner's capability
  signatures for the 205 and 601 still apply; Ticket 03 confirms its digest.

The shared vectors are `conformance/bwg-bitaxe-onboarding-0.2/settings-hmac-vectors.json`,
generated by `scripts/generate-bitaxe-settings-hmac-vectors.mjs`, an implementation
independent of `web/bitaxe-settings-hmac.ts`. The encoding is in
`docs/protocol/bwg-0.1-bitaxe-onboarding.md`.

## Consequences

- A stock build older than the C image's layout runs upstream's boot migrations on the
  first boot of the C image (legacy pool keys to `pool_1`, `asicfrequency` to
  `asicfrequency_f`, `themecolors` to `themecolor`). The new keys change the HMACs, so
  verification fails and onboarding rolls back. That is safe, but such a board needs a stock
  update first. A hostname changed by mDNS conflict resolution during the reboot also rolls
  back.
- Stock ESP-Miner has no Worker Serial, so it can neither be inspected over it nor answer a
  post-reboot verify after a rollback to it. Ticket 04 says how the browser inspects stock
  and checks a rollback to stock, and may revise this contract to do so.
- A rollback from the download in a later page has no in-memory evidence to compare. It
  needs the browser's own NVS parser, which Ticket 04 builds.

## Considered options

- **Keep plain SHA-256 digests** (ADR-0046). Rejected for offline guessing and replay.
- **Let the device pick the nonce.** A device could then answer from a stored reply; the
  browser's nonce proves the reply is fresh.
- **Count upstream's table as `esp32-ota-ab`.** That scheme has no `factory` slot, and stock
  boards run from `factory`.
- **Keep `bwg-reference-firmware/0.1`.** Old parsers would have refused the new scheme
  anyway, but one identifier for two payload formats makes a signed manifest ambiguous.
