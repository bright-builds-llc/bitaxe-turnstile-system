# Ticket 15 signing hand-off: the newer package for a reference-to-reference update

Prepared 2026-11-15 by an agent. No agent used, read or looked for your private keys. Signing is
yours. Paths under `~/.bitaxe-fork-private/` are outside both repositories.

## What is ready

- **Image.** C fork commit `57b0841` (on `origin/master`, one commit after `51e5af9`, changing
  only `TASKS.md` and the evidence page). It was built the same way as Ticket 05's image: ESP-IDF
  v6.0.2, a fresh detached worktree, an empty build directory, and `BWG_TRUST_DIR` set to your
  public trust and signed capabilities. It reports `v2.15.2rc0-88-g57b0841`, not dirty.
- **Package files**, in `~/.bitaxe-fork-private/reference/package-57b0841/files/` (`SHA256SUMS`
  and `PROVENANCE` there):

  | File | Source | SHA-256 |
  | --- | --- | --- |
  | `esp-miner.bin` (2,989,344 bytes) | `57b0841` | `bfc7990daf54f5df7828271f98dd05ce6cb8f7b326bf05a7a5908d88027ea673` |
  | `esp-miner.elf` | `57b0841` | `8b4fc68a2485aa950cebbfadf9e0f37a07d3a51f6abb50158e9d0d1db2f83ba9` |
  | `bootloader/bootloader.bin` | `51e5af9`, as signed in Ticket 05 | `8b9f8b046a30fc2d132760e995991707dd208ce35c9a939983b7fe076661d52d` |
  | `partition_table/partition-table.bin` | `51e5af9`, as signed in Ticket 05 | `1b83e93c29e6244fbfc04a717fd85f6aaf286302fea765f5e732235ebd3007f2` |

  `57b0841`'s own bootloader differs from `51e5af9`'s only in its build timestamp and image
  checksum. The package keeps the one already signed and installed, so an update from `51e5af9`
  writes the inactive slot and `otadata`, not the bootloader. That choice was the agent's call.
- **Unsigned manifest**, in `~/.bitaxe-fork-private/reference/package-57b0841/`:
  `unsigned-manifest.json`, and `unsigned-manifest.payload` (674 bytes, SHA-256
  `2e0e211ed1cd74d2f509cd19183f74f52969d7da869f0f96551eef4db3bc5227`). It is Ticket 05's
  manifest with two fields changed:
  - `imageSha256` is the new image's digest;
  - `sourceUrl` follows the rule you chose then, the fork's public commit:
    `https://github.com/bright-builds-llc/bitaxe-esp-miner-c/tree/57b084140f672c087238fdbd92541643fc078e42`.

  `parseFirmwareManifest` accepts it. A full admission dry run under a throwaway in-memory key
  accepts it for the 205 and the 601, from stock and from a reference image. Your public trust
  refuses it at the signature, the one piece missing.

## Why there is nothing else to sign

- **Version stays `0.1.0`.** Onboarding installs over a reference board without comparing
  versions, and after an install it needs the board's signed capability version to equal the
  manifest's. Your capabilities sign `0.1.0`. A distinct version would need new capabilities, a
  rebuild that embeds them, and a new manifest. Here "newer" means the later commit.
- **Capabilities are unchanged.** `git diff 51e5af9 57b0841` touches no source, so the Worker
  Serial manifest your capabilities bind, and every other claimed value, are the same.

## Sign

Same command and key as Ticket 05: the **Update Authority** key, from the authority directory
that signed your capabilities and Ticket 05's manifest. Run it from a turnstile checkout of `main`:

```bash
bun scripts/worker-development-authority.ts sign-firmware-manifest --directory <your authority directory> --input ~/.bitaxe-fork-private/reference/package-57b0841/unsigned-manifest.json --output ~/.bitaxe-fork-private/reference/package-57b0841/signed-manifest.json
```

It should print `firmware_manifest=signed version=0.1.0` and nothing secret. The output is public.

## After you sign

An agent checks the signed package against your public trust with
`package-57b0841/verify_signed_manifest.ts`. Then the sitting runs on the 601:

1. Install Ticket 05's package (`51e5af9`) from `247d2cd`, and keep it.
2. Install this package over it. Onboarding sees a reference board, writes `57b0841` to the other
   slot, and verifies it over Worker Serial.
3. Roll back to `51e5af9`, which is checked over Worker Serial this time, since that image answers
   onboarding commands.
4. Write back the 601's pre-install backup so it is on `247d2cd` again.

The licence reviews from Ticket 05 still apply before this image goes to anyone else.
