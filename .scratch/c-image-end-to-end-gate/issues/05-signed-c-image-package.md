# Owner signs the C image's firmware package

Type: task
Status: ready-for-human
Blocked by: 03, 04

## Objective

Onboarding installs only a package whose `bwg-firmware-manifest+jws` the Update
Authority signed. Only the owner signs it. Agents prepare the unsigned manifest
and check the signed one; they never handle the owner's keys.

## Plan

- [x] Agent: build the reference image from a pushed C-repository commit with the
  owner's public trust, and record its commit, image and ELF digests.
- [x] Agent: prepare the unsigned manifest (version, image digest, boards 205 and
  601, `esp32-factory-ota-ab` with rollback, settings schema `1`, public HTTPS
  source).
- [ ] Owner: review the GPL source and notice obligations before distributing the
  image, as the C repository's owner decisions require.
- [ ] Owner: sign the manifest, and new capabilities if Ticket 03 changed the
  Worker Serial manifest.
- [ ] Agent: verify the signed manifest against the owner's public trust with the
  Gate's package admission.

## Comments

- 2026-11-11 (Ticket 04, ADR-0112): the package now carries the C bootloader
  (`build/bootloader/bootloader.bin`) and the C table's `0xC00`-byte
  `partition-table.bin` beside the image. The manifest binds their SHA-256 digests in
  `firstInstall: { bootloaderSha256, partitionTableSha256 }`. Admission refuses a table that
  isn't exactly the C table. The unsigned manifest must include the block.
- 2026-11-12 (agent half done; waits on the owner's signature):
  [signing-handoff-05.md](../signing-handoff-05.md) says what to sign, with which key and command,
  and what to decide and review first.
  - Image: C commit `51e5af9` (`origin/master`), owner trust, ESP-IDF v6.0.2, fresh worktree, empty
    build directory, reporting `v2.15.2rc0-87-g51e5af9`, not dirty. Rollback is on, BLE is off. It
    holds the owner's four kids and none of the test authority's. SHA-256:
    - `esp-miner.bin`: `b8104b945f195032d98c87c1e7718b2a12723541e5b5b55796fb55163e4a02f9`
    - ELF: `dc8b8319c1f5fcda389eb25242b32a7c433e358556ac5007a3c631234f1a92b8`
    - `bootloader.bin`: `8b9f8b046a30fc2d132760e995991707dd208ce35c9a939983b7fe076661d52d`
    - `partition-table.bin`: `1b83e93c29e6244fbfc04a717fd85f6aaf286302fea765f5e732235ebd3007f2`

    The table equals, byte for byte, `encodePartitionTable(KNOWN_PARTITION_TABLES.c)`, and is the
    same table as `247d2cd`'s. The files are in `~/.bitaxe-fork-private/reference/image-51e5af9/`.
  - Unsigned manifest: `~/.bitaxe-fork-private/reference/package-51e5af9/unsigned-manifest.json`,
    with its canonical payload beside it. It carries:
    - version `0.1.0`;
    - boards `bitaxe-ultra` 205 and `bitaxe-gamma` 601;
    - `esp32-factory-ota-ab` with a 4 MiB minimum slot and rollback required;
    - settings schema `1`;
    - the `firstInstall` digests.

    `parseFirmwareManifest` (now exported from `web/bitaxe-firmware-package.ts`) accepts it. A full
    `admitFirmwarePackage` dry run under a throwaway in-memory key accepted the real bytes for both
    boards, from stock and from reference. The owner's public trust refuses the package at the
    signature, which is the one piece missing.
  - `sourceUrl` is a placeholder (`https://owner-decides-the-source.invalid/…`), because no ticket,
    spec or ADR names where the image is hosted. The owner sets it.
  - The version is `0.1.0`, because after an install `verifyInstalledDevice` needs the signed
    capability's version to equal the manifest's. A new version means new capabilities, a rebuild
    and a new manifest.
  - Capabilities: Ticket 03 changed nothing they sign, so no new signature is needed. The canonical
    Worker Serial manifest digest is `a43c2c7d61f95fc6` at `57d7be9`, `247d2cd` and `51e5af9`. It
    equals `serialManifestSha256` in both signed capabilities, and Ticket 03's diff touches no other
    claimed value.
  - Tooling: `bun scripts/worker-development-authority.ts sign-firmware-manifest` signs with the
    active Update Authority key. It refuses a manifest that admission would refuse. A test signs with
    a throwaway authority and admits the result.
  - Before distribution, the owner reviews the GPL source and notice obligations, and the licence of
    esptool-js 0.7.0's stub flashers. The stubs carry no licence header, and the package declares
    Apache-2.0. ADR-0112 is still proposed.
  - For Ticket 15: inspection calls any reference board that reports `compatible` `ready`, without
    comparing versions. A 601 on `247d2cd` reports `0.1.0` but lacks `onboarding_inspect`, so
    onboarding stops there, after Hello.
- 2026-11-13 (owner review of `fa9cbbe`: "Fix, then land"): the Ticket 15 note above is fixed.
  - A board on `247d2cd` is admitted, found to lack `onboarding_inspect` by the controller's own
    `command_rejected`/`invalid_request` reply, then inspected from flash under its signed
    capability.
  - The install writes the image and the signed C bootloader, because `247d2cd`'s bootloader has app
    rollback off. It then verifies `51e5af9` over Worker Serial.
  - A rollback returns to `247d2cd` and is checked from flash.
  - Details are on Ticket 04. The manifest and image are unchanged. The owner signs from `main` once
    this branch lands.
