#!/usr/bin/env bun
/**
 * Builds the public `#bwg-reference-config` JSON for `reference/account-creation.html`
 * (Ticket 07). Every input is public: the Gate Pass JWKS, the owner's Worker
 * deployment trust and the C image's digests.
 *
 * Usage: bun scripts/gate-deployment-page-config.ts --origin URL --public-keys FILE
 *          --owner-trust FILE --image-dir DIR --gate-commit COMMIT
 *   --image-dir holds the C image's COMMIT and SHA256SUMS; the one `.elf` line in
 *   SHA256SUMS is the app ELF.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseWorkerDeploymentTrust } from "../web/worker-deployment-trust";

/** Espressif's USB-JTAG/serial interface on the ESP32-S3 boards the C image runs on. */
const DEVICE_FILTER = { usbVendorId: 0x303a, usbProductId: 0x1001 } as const;
/** 2^48, above the Standard Work Requirement and the 2^44 floor Ticket 07 sets. */
const WORK_CEILING = "281474976710656";
const WORKERS = [{ workerId: "bitaxe-601", displayName: "Bitaxe 601", hashrateHs: "1200000000000" }];
const SOURCE_URL = "https://github.com/bright-builds-llc/bitaxe-turnstile-system";

export type PageConfigInput = {
  origin: string;
  publicKeys: unknown;
  ownerTrust: unknown;
  imageCommit: string;
  sha256Sums: string;
  gateCommit: string;
};

/** The app ELF's digest: the only SHA256SUMS line naming a `.elf` file. */
export function appElfSha256(sha256Sums: string): string {
  const elfLines = sha256Sums
    .split("\n")
    .map((line) => /^([0-9a-f]{64}) [ *]?(\S+\.elf)$/u.exec(line.trim()))
    .filter((match) => match !== null);
  const [only, ...others] = elfLines;
  if (!only || others.length > 0) throw new Error("SHA256SUMS must name exactly one .elf file");
  return only[1] as string;
}

export function buildPageConfig(input: PageConfigInput) {
  if (!/^https:\/\/[^/]+$/u.test(input.origin)) throw new Error("origin must be https://HOST");
  if (!/^[0-9a-f]{40}$/u.test(input.imageCommit)) throw new Error("COMMIT must be a 40-hex commit");
  if (!/^[0-9a-f]{40}$/u.test(input.gateCommit)) throw new Error("the Gate commit must be 40 hex");
  if (!Array.isArray(input.publicKeys) || input.publicKeys.length === 0) {
    throw new Error("the Gate Pass public keys must be a non-empty array");
  }
  const trust = parseWorkerDeploymentTrust(input.ownerTrust);
  return {
    authorityTrust: { issuer: input.origin, trustedKeys: input.publicKeys },
    workers: WORKERS,
    claimantWorkCeiling: WORK_CEILING,
    clientSafetyCeiling: WORK_CEILING,
    provenance: { sourceUrl: SOURCE_URL, protocolVersion: "BWG/0.1", appVersion: input.gateCommit },
    worker: {
      deviceFilter: DEVICE_FILTER,
      trustedUpdateKeys: trust.updateAuthority.keys,
      expectedFirmwareSourceCommit: input.imageCommit,
      expectedAppElfSha256: appElfSha256(input.sha256Sums),
    },
  };
}

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const imageDir = option(args, "--image-dir");
  const config = buildPageConfig({
    origin: option(args, "--origin"),
    publicKeys: JSON.parse(await readFile(option(args, "--public-keys"), "utf8")),
    ownerTrust: JSON.parse(await readFile(option(args, "--owner-trust"), "utf8")),
    imageCommit: (await readFile(join(imageDir, "COMMIT"), "utf8")).trim(),
    sha256Sums: await readFile(join(imageDir, "SHA256SUMS"), "utf8"),
    gateCommit: option(args, "--gate-commit"),
  });
  console.log(JSON.stringify(config));
}
