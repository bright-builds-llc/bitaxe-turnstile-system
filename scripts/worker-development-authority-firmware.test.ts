import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { admitFirmwarePackage, type FirmwareManifest } from "../web/bitaxe-firmware-package";
import { sha256Base64UrlBytes } from "../web/crypto-bytes";
import { bootloader, image, partitionTable, snapshot } from "../web/bitaxe-onboarding-test-fixtures";
import { parseWorkerDeploymentTrust } from "../web/worker-deployment-trust";

let parent = "";
let directory = "";

beforeEach(async () => {
  // Each test signs with a throwaway authority generated here; no existing key is read.
  parent = await mkdtemp(join(tmpdir(), "bwg-worker-firmware-manifest-test-"));
  directory = join(parent, "authority");
  expect((await authority(["init", "--directory", directory])).exitCode).toBe(0);
});

afterEach(async () => {
  await rm(parent, { recursive: true });
});

test("signs a manifest that package admission accepts under the authority's public trust", async () => {
  // Arrange
  const manifest = await unsignedManifest();
  const inputPath = await writeInput(manifest);
  const outputPath = join(parent, "signed-manifest.json");

  // Act
  const result = await signManifest(inputPath, outputPath);

  // Assert
  expect(result).toEqual({
    exitCode: 0,
    stderr: "",
    stdout: "firmware_manifest=signed version=0.1.0\n",
  });
  const signed = JSON.parse(await readFile(outputPath, "utf8")) as {
    manifest: FirmwareManifest;
    signature: string;
  };
  const trust = parseWorkerDeploymentTrust(
    JSON.parse(await readFile(join(directory, "trust.json"), "utf8")),
  );
  await expect(
    admitFirmwarePackage(
      { manifest: signed.manifest, image, bootloader, partitionTable, signature: signed.signature },
      trust.updateAuthority.keys,
      snapshot({
        capabilities: {
          ...snapshot().capabilities,
          board: { model: "bitaxe-gamma", revision: "601", usbTransport: "web_serial" },
        },
        partition: { ...snapshot().partition, appSlotBytes: 4_194_304 },
      }),
    ),
  ).resolves.toMatchObject({ manifest });
});

test.each([
  ["a 0.1 profile", { profile: "bwg-reference-firmware/0.1" }],
  ["a plain-HTTP source", { sourceUrl: "http://example.invalid/image" }],
  ["a manifest without its first-install digests", { firstInstall: undefined }],
] as const)("refuses %s without writing a signature", async (_name, overrides) => {
  // Arrange
  const inputPath = await writeInput({ ...(await unsignedManifest()), ...overrides });
  const outputPath = join(parent, "signed-manifest.json");

  // Act
  const result = await signManifest(inputPath, outputPath);

  // Assert
  expect(result).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: "worker_development_authority=failed category=invalid_operation\n",
  });
  await expect(readFile(outputPath)).rejects.toThrow();
});

async function unsignedManifest(): Promise<FirmwareManifest> {
  return {
    profile: "bwg-reference-firmware/0.2",
    firmwareVersion: "0.1.0",
    imageSha256: await sha256Base64UrlBytes(image),
    compatibleBoards: [
      { model: "bitaxe-ultra", revisions: ["205"] },
      { model: "bitaxe-gamma", revisions: ["601"] },
    ],
    partition: {
      scheme: "esp32-factory-ota-ab",
      minimumAppSlotBytes: 4_194_304,
      rollbackRequired: true,
    },
    settingsSchema: { minimumReadable: 1, maximumReadable: 1, target: 1 },
    firstInstall: {
      bootloaderSha256: await sha256Base64UrlBytes(bootloader),
      partitionTableSha256: await sha256Base64UrlBytes(partitionTable),
    },
    sourceUrl: "https://example.invalid/reference-firmware",
  };
}

async function writeInput(manifest: unknown): Promise<string> {
  const path = join(parent, "unsigned-manifest.json");
  await writeFile(path, JSON.stringify(manifest), { mode: 0o644 });
  return path;
}

function signManifest(inputPath: string, outputPath: string) {
  return authority([
    "sign-firmware-manifest",
    "--directory",
    directory,
    "--input",
    inputPath,
    "--output",
    outputPath,
  ]);
}

async function authority(args: readonly string[]) {
  const child = Bun.spawn(
    ["bun", "scripts/worker-development-authority.ts", ...args],
    { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
