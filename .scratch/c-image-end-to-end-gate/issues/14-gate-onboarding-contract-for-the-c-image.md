# Gate onboarding contract matches the C image

Type: task
Status: ready-for-agent
Blocked by: 02

## Objective

Change this repository's onboarding contract to Ticket 02's decisions, so the C
image (03) and the browser installer (04) build against one versioned contract
and shared vectors. Contract and tests only; no ROM client and no firmware.

## Plan

- [ ] A new ADR recording Ticket 02: one ROM writer, the first-install
  bootloader and table write, `esp32-factory-ota-ab`, per-schema categories,
  nonce-keyed HMAC digests, browser-driven rollback after mark-valid, and the
  rollback copy below. It amends ADR-0046 and says whether
  `bwg-reference-firmware/0.1` keeps its identifier.
- [ ] The raw NVS copy for rollback lives only in browser memory while onboarding
  runs, as a bounded plaintext buffer like today's. It is wiped when the user
  completes onboarding or anything fails, and never reaches browser storage.
- [ ] The passphrase-encrypted Migration Backup download (ADR-0046) stays
  optional, and is offered prominently for a first install from stock. If the tab
  closes first, the device keeps the C image, which has passed its startup check,
  and a later rollback needs that download.
- [ ] `rollbackState` is `available` only while the in-memory copy exists, or when
  the user supplies the download.
- [ ] The manifest's partition block and the snapshot and verify parsers accept
  `esp32-factory-ota-ab`, with `factory` as an active slot, and refuse any other
  scheme.
- [ ] Schema `1` names each category's exact keys from upstream's
  `main/nvs_config.c`, replacing the `wifi_` prefix rule.
- [ ] Verify sends a random per-onboarding nonce, and every category digest is an
  HMAC under it. Parsers refuse a plain SHA-256 digest or a reply under another
  nonce.
- [ ] Simulator, browser conformance fixture and protocol doc updated, with
  vectors the C image's host tests can reuse. `bun run verify` passes.

## Comments

- 2026-11-06: the owner chose "Memory, download optional" for how the rollback
  copy is kept.
