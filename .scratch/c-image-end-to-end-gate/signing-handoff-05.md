# Ticket 05 signing hand-off for the owner

Prepared 2026-11-12 by an agent. No agent used, read or looked for your private keys. Each step
below is yours. Paths under `~/.bitaxe-fork-private/` are outside both repositories.

## What is ready

- **Image.** C fork commit `51e5af9` (on `origin/master`), built with ESP-IDF v6.0.2 in a fresh
  detached worktree with an empty build directory and `BWG_TRUST_DIR` set to your public trust and
  your two signed capabilities. It reports `v2.15.2rc0-87-g51e5af9`, not dirty. The files are in
  `~/.bitaxe-fork-private/reference/image-51e5af9/`, and `SHA256SUMS` there holds:

  | File | SHA-256 |
  | --- | --- |
  | `esp-miner.bin` (2,989,344 bytes) | `b8104b945f195032d98c87c1e7718b2a12723541e5b5b55796fb55163e4a02f9` |
  | `esp-miner.elf` | `dc8b8319c1f5fcda389eb25242b32a7c433e358556ac5007a3c631234f1a92b8` |
  | `bootloader/bootloader.bin` (22,624 bytes) | `8b9f8b046a30fc2d132760e995991707dd208ce35c9a939983b7fe076661d52d` |
  | `partition_table/partition-table.bin` (3,072 bytes) | `1b83e93c29e6244fbfc04a717fd85f6aaf286302fea765f5e732235ebd3007f2` |

- **Unsigned manifest.** It is in `~/.bitaxe-fork-private/reference/package-51e5af9/`:
  - `unsigned-manifest.json` is the `bwg-reference-firmware/0.2` manifest, the input to the
    command below.
  - `unsigned-manifest.payload` is its exact canonical JSON, the bytes the JWS payload encodes:
    640 bytes, SHA-256 `7c53ad82…304e` while the source is the placeholder.
  - `prepare_unsigned_manifest.ts` builds both files and reruns the checks.

## Decide before you sign

1. **Source URL.** No ticket, spec or ADR names where the image is hosted, so `sourceUrl` is a
   placeholder: `https://owner-decides-the-source.invalid/bitaxe-esp-miner-c/51e5af9`. It must be a
   public HTTPS URL with no credentials, query or fragment. You also choose whether it names the
   image's download location or its corresponding source. One candidate for the source is the
   fork's public commit, but that is your call. Set it by editing the field, or by rerunning the
   prepare script with your URL as the fourth argument (see "To rebuild the payload" below). The
   signing command checks it again.
2. **Version stays `0.1.0` unless you re-sign capabilities.** After an install, onboarding requires
   the board's signed capability version to equal the manifest's `firmwareVersion`
   (`web/bitaxe-onboarding-recovery.ts`). Your capabilities sign `0.1.0`, so the manifest says
   `0.1.0`. The `247d2cd` image you run today also says `0.1.0`. The Gate pins images by commit and
   ELF, not by version. A distinct version needs three things:
   - new capabilities naming it;
   - a rebuild that embeds them;
   - a new manifest.

## Capabilities: no new signature is needed

Ticket 03 did not change what your capabilities sign. Each capability binds the SHA-256 of the
canonical Worker Serial manifest, and its other claims are these:

- `bwg-worker-controller/0.4`
- `bwg-worker-serial/0.2`
- `bright-builds-reference-firmware` `0.1.0`
- the board
- the compatibility values

The manifest's canonical digest is `a43c2c7d61f95fc6…` (`pDwsfWH5…NhU`). It is the same at
`57d7be9`, `247d2cd` and `51e5af9`, and it equals the `serialManifestSha256` in both
`capability-205.json` and `capability-601.json`. `git diff 247d2cd 51e5af9` touches none of the
other claimed values: the onboarding commands use the existing 0.4 envelope.

## Sign

The key role is the **Update Authority** (`update_authority`), the same key that signed your
capabilities. The command signs with your authority directory's active update key. Both of your
update kids are in the image's embedded trust.

From a turnstile checkout of branch `claude/ticket-05-package-87fc3d`, where the command was added:

```bash
bun scripts/worker-development-authority.ts sign-firmware-manifest --directory <your authority directory> --input ~/.bitaxe-fork-private/reference/package-51e5af9/unsigned-manifest.json --output ~/.bitaxe-fork-private/reference/package-51e5af9/signed-manifest.json
```

It parses the manifest as admission does and refuses an inadmissible one. It then writes
`{ manifest, signature }`, where `signature` is the compact `bwg-firmware-manifest+jws`. It prints
`firmware_manifest=signed version=0.1.0` and nothing secret. The output is public.

To rebuild the payload with your source URL, run this from the same checkout:

```bash
bun ~/.bitaxe-fork-private/reference/package-51e5af9/prepare_unsigned_manifest.ts "$PWD" ~/.bitaxe-fork-private/reference/image-51e5af9 0.1.0 <your HTTPS source URL> ~/.bitaxe-fork-private/reference/package-51e5af9
```

## Review before distributing the image

Neither review below is done. These are facts an agent found, not a conclusion.

1. **GPL-3.0 source and notice obligations.** This is the C repository's owner decision. The image
   is ESP-Miner (GPL-3.0) with upstream's notices kept, plus code moved from the Rust repository
   under its MIT notice. Commit `51e5af9` is public on `origin/master`. Things to check:
   - whether that, together with your chosen `sourceUrl`, meets the corresponding-source duty for
     the way you distribute;
   - which notices must travel with the image.

   The bootloader is ESP-IDF's, which is Apache-2.0, so include it in the same review.
2. **esptool-js 0.7.0's bundled stub flasher binaries.** Ticket 04 bundles esptool-js beside
   `bwg-core`, which is MIT. The package declares Apache-2.0, and its README applies that to "the
   code in this repository". The 17 stub images in `lib/targets/stub_flasher/*.json` are base64
   blobs with no licence or provenance header of their own. No agent established where they come
   from or what licence they carry. Separately, Apache-2.0 asks that its licence and any NOTICE
   travel with redistribution.

## Also waiting on you

ADR-0112 is still **proposed**. It holds Ticket 04's own choices, including the `firstInstall`
block this manifest carries. Accept or amend it before Ticket 15 runs onboarding on the 601.

## After you sign

An agent runs Ticket 05's last item: Gate package admission of the signed manifest, the image, the
bootloader and the table against your public trust (`owner-trust/trust.json`).
