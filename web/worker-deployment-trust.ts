import { encodeBase64Url, sha256Base64UrlBytes } from "./crypto-bytes";
import { isCanonicalPrimeSubgroupEd25519PublicKey } from "./ed25519-public-key";
import { canonicalJson } from "./headless-values";
import {
  WORKER_DEPLOYMENT_TRUST_PROFILE,
  parseWorkLeaseAuthorityTrust,
  type WorkLeaseAuthorityJwk,
  type WorkLeaseAuthorityTrust,
} from "./worker-lease-authorization";
import {
  parseWorkerControllerCapabilities,
  type WorkerControllerCapabilities,
} from "./worker-controller";
import {
  parseWorkerSerialManifest,
  type WorkerSerialManifest,
} from "./worker-serial";

/** Strict public Update Authority verification key. */
export type UpdateAuthorityJwk = WorkLeaseAuthorityJwk;

/** Update Authority half of deployment trust. */
export type UpdateAuthorityTrust = {
  issuer: string;
  audience: "bwg-reference-firmware-capability/0.2";
  role: "update_authority";
  keys: readonly UpdateAuthorityJwk[];
};

/** Role-separated trust installed into the reference deployment. */
export type WorkerDeploymentTrust = {
  profile: typeof WORKER_DEPLOYMENT_TRUST_PROFILE;
  updateAuthority: UpdateAuthorityTrust;
  workLeaseAuthority: WorkLeaseAuthorityTrust;
};

/** Controller capability shape before Update Authority attestation. */
export type UnsignedWorkerControllerCapability = Omit<
  WorkerControllerCapabilities,
  "attestation"
>;

/** Parses strict role-separated trust and rejects all key aliases. */
export function parseWorkerDeploymentTrust(input: unknown): WorkerDeploymentTrust {
  const value = exactRecord(input, [
    "profile",
    "updateAuthority",
    "workLeaseAuthority",
  ]);
  if (value.profile !== WORKER_DEPLOYMENT_TRUST_PROFILE) {
    throw invalidTrust();
  }
  const updateAuthority = parseUpdateAuthorityTrust(value.updateAuthority);
  const workLeaseAuthority = parseWorkLeaseAuthorityTrust(value.workLeaseAuthority);
  const updateKeyIds = new Set(updateAuthority.keys.map((key) => key.kid));
  const updatePublicKeys = new Set(updateAuthority.keys.map((key) => key.x));
  if (
    workLeaseAuthority.keys.some((key) =>
      updateKeyIds.has(key.kid) || updatePublicKeys.has(key.x)
    )
  ) {
    throw invalidTrust();
  }
  return {
    profile: WORKER_DEPLOYMENT_TRUST_PROFILE,
    updateAuthority,
    workLeaseAuthority,
  };
}

/** Signs one Ultra 205 Controller capability with the Update Authority. */
export async function signWorkerControllerCapability(input: {
  capability: UnsignedWorkerControllerCapability;
  manifest: WorkerSerialManifest;
  kid: string;
  privateKey: CryptoKey;
}): Promise<WorkerControllerCapabilities> {
  try {
    const capability = structuredClone(input.capability);
    if (Object.hasOwn(capability, "attestation")) throw invalidTrust();
    const manifest = parseWorkerSerialManifest(
      structuredClone(input.manifest),
    );
    const kid = keyId(input.kid);
    assertPrivateSigningKey(input.privateKey);
    const claims = {
      profile: "bwg-reference-firmware-capability/0.2" as const,
      protocolVersion: capability.protocolVersion,
      board: {
        model: capability.board.model,
        revision: capability.board.revision,
      },
      firmware: capability.firmware,
      compatibility: capability.compatibility,
      transportProfile: capability.transportProfile,
      serialManifestSha256: await sha256Base64UrlBytes(
        new TextEncoder().encode(canonicalJson(manifest)),
      ),
    };
    const header = {
      alg: "Ed25519",
      kid,
      typ: "bwg-worker-capability+jws",
    };
    const protectedHeader = encodeBase64Url(
      new TextEncoder().encode(canonicalJson(header)),
    );
    const payload = encodeBase64Url(
      new TextEncoder().encode(canonicalJson(claims)),
    );
    const signingInput = protectedHeader + "." + payload;
    const signature = await crypto.subtle.sign(
      "Ed25519",
      input.privateKey,
      new TextEncoder().encode(signingInput).buffer,
    );
    return parseWorkerControllerCapabilities({
      ...capability,
      attestation: {
        claims,
        compactJws:
          signingInput + "." + encodeBase64Url(new Uint8Array(signature)),
      },
    });
  } catch {
    throw invalidTrust();
  }
}

function parseUpdateAuthorityTrust(input: unknown): UpdateAuthorityTrust {
  const value = exactRecord(input, [
    "issuer",
    "audience",
    "role",
    "keys",
  ]);
  if (
    !label(value.issuer) ||
    value.audience !== "bwg-reference-firmware-capability/0.2" ||
    value.role !== "update_authority" ||
    !Array.isArray(value.keys) ||
    value.keys.length === 0 ||
    value.keys.length > 8
  ) {
    throw invalidTrust();
  }
  const keys = value.keys.map(parsePublicKey);
  if (new Set(keys.map((key) => key.kid)).size !== keys.length) {
    throw invalidTrust();
  }
  if (new Set(keys.map((key) => key.x)).size !== keys.length) {
    throw invalidTrust();
  }
  return {
    issuer: value.issuer,
    audience: value.audience,
    role: "update_authority",
    keys,
  };
}

function parsePublicKey(input: unknown): UpdateAuthorityJwk {
  const value = exactRecord(input, [
    "kid",
    "kty",
    "crv",
    "x",
    "alg",
    "use",
    "key_ops",
  ]);
  if (
    typeof value.kid !== "string" ||
    keyId(value.kid) !== value.kid ||
    value.kty !== "OKP" ||
    value.crv !== "Ed25519" ||
    !isCanonicalPrimeSubgroupEd25519PublicKey(value.x) ||
    value.alg !== "Ed25519" ||
    value.use !== "sig" ||
    !Array.isArray(value.key_ops) ||
    value.key_ops.length !== 1 ||
    value.key_ops[0] !== "verify"
  ) {
    throw invalidTrust();
  }
  return {
    kid: value.kid,
    kty: "OKP",
    crv: "Ed25519",
    x: value.x,
    alg: "Ed25519",
    use: "sig",
    key_ops: ["verify"],
  };
}

function assertPrivateSigningKey(key: CryptoKey): void {
  if (
    key.type !== "private" ||
    key.algorithm.name !== "Ed25519" ||
    !key.usages.includes("sign")
  ) {
    throw invalidTrust();
  }
}

function exactRecord(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidTrust();
  }
  const value = input as Record<string, unknown>;
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    !actual.every((key) => keys.includes(key))
  ) {
    throw invalidTrust();
  }
  return value;
}

function keyId(input: unknown): string {
  if (typeof input !== "string" || !/^[A-Za-z0-9_-]{1,32}$/u.test(input)) {
    throw invalidTrust();
  }
  return input;
}

function label(input: unknown): input is string {
  return typeof input === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(input);
}

function invalidTrust(): Error {
  return new Error("Worker deployment trust is invalid");
}
