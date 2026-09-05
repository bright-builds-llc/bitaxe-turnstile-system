import { sha256Base64UrlBytes } from "../web/crypto-bytes";
import { isCanonicalPrimeSubgroupEd25519PublicKey } from "../web/ed25519-public-key";
import { parseWorkerDeploymentTrust } from "../web/worker-deployment-trust";

const PRIVATE_PROFILE = "bwg-worker-private-authority/0.1";
const TRUST_PROFILE = "bwg-worker-deployment-trust/0.2";

export type AuthorityRole = "update_authority" | "work_lease_authority";

export type PrivateAuthority = {
  profile: typeof PRIVATE_PROFILE;
  role: AuthorityRole;
  activeKid: string;
  keys: Array<JsonWebKey & { kid: string }>;
};

export async function createAuthority(
  role: AuthorityRole,
): Promise<PrivateAuthority> {
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (!privateJwk.d || !publicJwk.x) throw new Error("key_generation_failed");
  const digest = await sha256Base64UrlBytes(
    new TextEncoder().encode(publicJwk.x),
  );
  const prefix = role === "update_authority" ? "dev-update-" : "dev-lease-";
  const kid = prefix + digest.slice(0, 16);
  return {
    profile: PRIVATE_PROFILE,
    role,
    activeKid: kid,
    keys: [
      {
        ...privateJwk,
        kid,
        alg: "Ed25519",
        use: "sig",
        key_ops: ["sign"],
        ext: false,
      },
    ],
  };
}

export function parsePrivateAuthority(
  input: unknown,
  role: AuthorityRole,
): PrivateAuthority {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("private_authority_invalid");
  }
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== 4 ||
    value.profile !== PRIVATE_PROFILE ||
    value.role !== role ||
    typeof value.activeKid !== "string" ||
    !/^[A-Za-z0-9_-]{1,32}$/u.test(value.activeKid) ||
    !Array.isArray(value.keys) ||
    value.keys.length === 0 ||
    value.keys.length > 8
  ) {
    throw new Error("private_authority_invalid");
  }
  const keys = value.keys as Array<JsonWebKey & { kid: string }>;
  if (
    keys.some(
      (key) =>
        Object.keys(key).length !== 9 ||
        typeof key.kid !== "string" ||
        !/^[A-Za-z0-9_-]{1,32}$/u.test(key.kid) ||
        key.kty !== "OKP" ||
        key.crv !== "Ed25519" ||
        !isCanonicalPrimeSubgroupEd25519PublicKey(key.x) ||
        typeof key.d !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/u.test(key.d) ||
        key.alg !== "Ed25519" ||
        key.use !== "sig" ||
        key.ext !== false ||
        !Array.isArray(key.key_ops) ||
        key.key_ops.length !== 1 ||
        key.key_ops[0] !== "sign",
    ) ||
    new Set(keys.map((key) => key.kid)).size !== keys.length ||
    new Set(keys.map((key) => key.x)).size !== keys.length ||
    !keys.some((key) => key.kid === value.activeKid)
  ) {
    throw new Error("private_authority_invalid");
  }
  return {
    profile: PRIVATE_PROFILE,
    role,
    activeKid: value.activeKid,
    keys,
  };
}

export function publicTrust(update: PrivateAuthority, lease: PrivateAuthority) {
  return parseWorkerDeploymentTrust({
    profile: TRUST_PROFILE,
    updateAuthority: {
      issuer: "development-update-authority",
      audience: "bwg-reference-firmware-capability/0.2",
      role: "update_authority",
      keys: update.keys.map(publicKey),
    },
    workLeaseAuthority: {
      profile: TRUST_PROFILE,
      issuer: "development-worker-lease-authority",
      audience: "bwg-worker-controller/0.4",
      role: "work_lease_authority",
      keys: lease.keys.map(publicKey),
    },
  });
}

function publicKey(key: JsonWebKey & { kid: string }) {
  if (!key.x) throw new Error("public_key_missing");
  return {
    kid: key.kid,
    kty: "OKP",
    crv: "Ed25519",
    x: key.x,
    alg: "Ed25519",
    use: "sig",
    key_ops: ["verify"],
  };
}
