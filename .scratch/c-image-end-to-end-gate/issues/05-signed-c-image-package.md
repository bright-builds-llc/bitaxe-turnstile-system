# Owner signs the C image's firmware package

Type: task
Status: ready-for-human
Blocked by: 03, 04

## Objective

Onboarding installs only a package whose `bwg-firmware-manifest+jws` the Update
Authority signed. Only the owner signs it. Agents prepare the unsigned manifest
and check the signed one; they never handle the owner's keys.

## Plan

- [ ] Agent: build the reference image from a pushed C-repository commit with the
  owner's public trust, and record its commit, image and ELF digests.
- [ ] Agent: prepare the unsigned manifest (version, image digest, boards 205 and
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
