import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeBase64Url } from "../web/crypto-bytes";
import {
  KEY_FILES,
  SERVICE_CLIENT_ID,
  isAcceptableServiceCredential,
  writeGateDeploymentKeys,
} from "./gate-deployment-keys";

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "gate-deployment-keys-"));
  try {
    await run(join(directory, "t07"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

test("writes every key file and the directory owner-only", async () => {
  await withDirectory(async (directory) => {
    // Act
    await writeGateDeploymentKeys(directory);

    // Assert
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    for (const name of Object.values(KEY_FILES)) {
      expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);
    }
  });
});

test("the signing seed signs for the published public key and kid", async () => {
  await withDirectory(async (directory) => {
    // Arrange
    const written = await writeGateDeploymentKeys(directory);
    const signing = await readJson(join(directory, KEY_FILES.signing));
    const publicKeys = JSON.parse(await readFile(join(directory, KEY_FILES.publicKeys), "utf8")) as unknown[];
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", d: String(signing.seed), x: written.publicJwk.x },
      "Ed25519",
      false,
      ["sign"],
    );
    const publicKey = await crypto.subtle.importKey("jwk", written.publicJwk, "Ed25519", false, ["verify"]);
    const message = new TextEncoder().encode("gate pass");

    // Act
    const signature = await crypto.subtle.sign("Ed25519", privateKey, message);

    // Assert
    expect(await crypto.subtle.verify("Ed25519", publicKey, signature, message)).toBe(true);
    expect(signing.kid).toBe(written.kid);
    expect(publicKeys).toEqual([written.publicJwk]);
    expect(decodeBase64Url(String(signing.seed), 43, "seed").byteLength).toBe(32);
  });
});

test("the service credential and Stratum key meet the Authority's formats", async () => {
  await withDirectory(async (directory) => {
    // Act
    await writeGateDeploymentKeys(directory);
    const service = await readJson(join(directory, KEY_FILES.serviceCredential));
    const stratum = await readJson(join(directory, KEY_FILES.stratumKey));

    // Assert
    expect(service.clientId).toBe(SERVICE_CLIENT_ID);
    expect(isAcceptableServiceCredential(String(service.credential))).toBe(true);
    expect(decodeBase64Url(String(stratum.key), 43, "stratum key").byteLength).toBe(32);
  });
});

test("what may be printed holds no private value", async () => {
  await withDirectory(async (directory) => {
    // Arrange
    const written = await writeGateDeploymentKeys(directory);
    const printed = JSON.stringify(written);

    // Act
    const secrets = [
      String((await readJson(join(directory, KEY_FILES.signing))).seed),
      String((await readJson(join(directory, KEY_FILES.serviceCredential))).credential),
      String((await readJson(join(directory, KEY_FILES.stratumKey))).key),
    ];

    // Assert
    for (const secret of secrets) expect(printed).not.toContain(secret);
  });
});

test("refuses to overwrite existing keys", async () => {
  await withDirectory(async (directory) => {
    // Arrange
    await writeGateDeploymentKeys(directory);
    const before = await readFile(join(directory, KEY_FILES.signing), "utf8");

    // Act
    const second = writeGateDeploymentKeys(directory);

    // Assert
    await expect(second).rejects.toThrow("refusing to overwrite");
    expect(await readFile(join(directory, KEY_FILES.signing), "utf8")).toBe(before);
  });
});

test("rejects service credentials with too few distinct characters", () => {
  // Act
  const repetitive = isAcceptableServiceCredential("ab".repeat(30));

  // Assert
  expect(repetitive).toBe(false);
});
