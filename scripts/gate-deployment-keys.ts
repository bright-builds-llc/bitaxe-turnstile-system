#!/usr/bin/env bun
/**
 * Generates a Gate deployment's own keys (Ticket 07). The owner runs it; agents
 * never see its output files.
 *
 * Usage: bun scripts/gate-deployment-keys.ts --directory DIR
 *
 * Writes, each new and mode 600, into DIR (mode 700, created if missing):
 * - `gate-pass-signing.json`: the Gate Pass signing kid and Ed25519 seed;
 * - `gate-pass-public-keys.json`: the JWKS entries for `BWG_AUTHORITY_JWKS_JSON`;
 * - `service-credential.json`: the Reference Relying Service's client id and credential;
 * - `stratum-credential-key.json`: the 32-byte Stratum credential key.
 * It refuses to overwrite any of them, and prints only the kid, the public JWK and
 * the file names.
 */
import { chmod, mkdir, open, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { encodeBase64Url, sha256Base64UrlBytes } from "../web/crypto-bytes";

export const KEY_FILES = {
  signing: "gate-pass-signing.json",
  publicKeys: "gate-pass-public-keys.json",
  serviceCredential: "service-credential.json",
  stratumKey: "stratum-credential-key.json",
} as const;

export const SERVICE_CLIENT_ID = "reference-account-creation";
const SERVICE_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;
const MINIMUM_DISTINCT_CREDENTIAL_CHARACTERS = 16;

export type AuthorityPublicJwk = {
  kid: string;
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  alg: "Ed25519";
  use: "sig";
  key_ops: ["verify"];
};

export type GateDeploymentKeys = {
  signing: { kid: string; seed: string };
  publicKeys: AuthorityPublicJwk[];
  serviceCredential: { clientId: string; credential: string };
  stratumKey: { key: string };
};

/** A service credential the Authority accepts: 43 to 128 base64url characters, 16 distinct. */
export function isAcceptableServiceCredential(credential: string): boolean {
  return (
    SERVICE_CREDENTIAL_PATTERN.test(credential) &&
    new Set(credential).size >= MINIMUM_DISTINCT_CREDENTIAL_CHARACTERS
  );
}

function randomBase64Url(byteLength: number): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

function newServiceCredential(): string {
  for (;;) {
    const credential = randomBase64Url(48);
    if (isAcceptableServiceCredential(credential)) return credential;
  }
}

export async function generateGateDeploymentKeys(): Promise<GateDeploymentKeys> {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (!privateJwk.d || !publicJwk.x) throw new Error("key_generation_failed");
  const digest = await sha256Base64UrlBytes(new TextEncoder().encode(publicJwk.x));
  const kid = `gate-pass-${digest.slice(0, 16)}`;
  return {
    signing: { kid, seed: privateJwk.d },
    publicKeys: [
      { kid, kty: "OKP", crv: "Ed25519", x: publicJwk.x, alg: "Ed25519", use: "sig", key_ops: ["verify"] },
    ],
    serviceCredential: { clientId: SERVICE_CLIENT_ID, credential: newServiceCredential() },
    stratumKey: { key: randomBase64Url(32) },
  };
}

async function writeNewPrivateJson(path: string, value: unknown): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await chmod(path, 0o600);
}

async function assertNoneExist(directory: string): Promise<void> {
  for (const name of Object.values(KEY_FILES)) {
    const exists = await stat(join(directory, name)).then(
      () => true,
      () => false,
    );
    if (exists) throw new Error(`refusing to overwrite ${name}`);
  }
}

/** Writes new keys into DIRECTORY and returns only what may be printed. */
export async function writeGateDeploymentKeys(directory: string): Promise<{
  kid: string;
  publicJwk: AuthorityPublicJwk;
  files: string[];
}> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await assertNoneExist(directory);
  const keys = await generateGateDeploymentKeys();
  await writeNewPrivateJson(join(directory, KEY_FILES.signing), keys.signing);
  await writeNewPrivateJson(join(directory, KEY_FILES.publicKeys), keys.publicKeys);
  await writeNewPrivateJson(join(directory, KEY_FILES.serviceCredential), keys.serviceCredential);
  await writeNewPrivateJson(join(directory, KEY_FILES.stratumKey), keys.stratumKey);
  const [publicJwk] = keys.publicKeys;
  if (!publicJwk) throw new Error("key_generation_failed");
  return { kid: keys.signing.kid, publicJwk, files: Object.values(KEY_FILES) };
}

if (import.meta.main) {
  const [flag, directory, ...rest] = Bun.argv.slice(2);
  if (flag !== "--directory" || !directory || rest.length > 0) {
    console.error("Usage: bun scripts/gate-deployment-keys.ts --directory DIR");
    process.exit(2);
  }
  const written = await writeGateDeploymentKeys(resolve(directory));
  console.log(JSON.stringify(written, null, 2));
}
