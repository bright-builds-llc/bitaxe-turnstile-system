import {
  decodeBase64Url,
  encodeBase64Url,
  sha256Base64UrlBytes,
} from "./crypto-bytes";
import { isCanonicalPrimeSubgroupEd25519PublicKey } from "./ed25519-public-key";
import { canonicalJson } from "./headless-values";
import {
  parseWorkerLeaseGrant,
  parseWorkerLeaseRenewal,
  type WorkerLeaseGrant,
  type WorkerLeaseRenewal,
} from "./worker-controller";

/** Canonical signed Work Lease authorization profile. */
export const WORKER_LEASE_AUTHORIZATION_PROFILE =
  "bwg-worker-lease-authorization/0.2" as const;
/** Role-separated deployment trust document profile. */
export const WORKER_DEPLOYMENT_TRUST_PROFILE =
  "bwg-worker-deployment-trust/0.2" as const;
/** Required compact-JWS protected-header type. */
export const WORKER_LEASE_AUTHORIZATION_TYPE =
  "bwg-worker-lease-authorization+jws" as const;
/** Controller 0.4 authorization-field byte limit. */
export const MAXIMUM_WORKER_LEASE_AUTHORIZATION_BYTES = 512;
/** Largest durable unsigned Work Lease authority sequence. */
export const MAXIMUM_WORKER_LEASE_AUTHORIZATION_SEQUENCE = (1n << 64n) - 1n;

/** Controller operation authorized by one signed artifact. */
export type WorkerLeaseAuthorizationOperation = "start" | "renew";

/** Possession-derived binding supplied separately from credentials. */
export type WorkerLeaseAuthorizationContext = {
  controlSessionBindingSha256: string;
};

/** Supplies a fresh or active possession context before Authority contact. */
export interface WorkerLeaseAuthorizationContextProvider {
  prepareWorkerLeaseAuthorizationContext(
    operation: WorkerLeaseAuthorizationOperation,
  ): Promise<WorkerLeaseAuthorizationContext>;
}

/** Start request shape before the opaque authorization is attached. */
export type AuthorizationlessWorkerLeaseGrant = Omit<
  WorkerLeaseGrant,
  "authorization"
>;
/** Renew request shape before the opaque authorization is attached. */
export type AuthorizationlessWorkerLeaseRenewal = Omit<
  WorkerLeaseRenewal,
  "authorization"
>;

/** Complete immutable input bound by a Work Lease authorization. */
export type WorkerLeaseAuthorizationInput =
  | {
      operation: "start";
      activeChallengeId: string;
      controlSessionBindingSha256: string;
      request: AuthorizationlessWorkerLeaseGrant;
    }
  | {
      operation: "renew";
      activeChallengeId: string;
      controlSessionBindingSha256: string;
      request: AuthorizationlessWorkerLeaseRenewal;
    };

/** Strict public Work Lease Authority verification key. */
export type WorkLeaseAuthorityJwk = JsonWebKey & {
  kid: string;
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  alg: "Ed25519";
  use: "sig";
  key_ops: readonly ["verify"];
};

/** Work Lease Authority half of deployment trust. */
export type WorkLeaseAuthorityTrust = {
  profile: typeof WORKER_DEPLOYMENT_TRUST_PROFILE;
  issuer: string;
  audience: "bwg-worker-controller/0.4";
  role: "work_lease_authority";
  keys: readonly WorkLeaseAuthorityJwk[];
};

/** Verified signer identity and durable replay sequence. */
export type VerifiedWorkerLeaseAuthorization = {
  keyId: string;
  sequence: bigint;
};

/** Signs one canonical, request- and possession-bound authorization. */
export async function signWorkerLeaseAuthorization(input: {
  input: WorkerLeaseAuthorizationInput;
  sequence: string;
  kid: string;
  issuer: string;
  audience: string;
  privateKey: CryptoKey;
}): Promise<string> {
  try {
    const admittedInput = parseAuthorizationInput(structuredClone(input.input));
    const sequence = parseSequence(input.sequence);
    const kid = parseKeyId(input.kid);
    const issuer = parseTrustLabel(input.issuer);
    const audience = parseAudience(input.audience);
    assertPrivateSigningKey(input.privateKey);
    const payload = {
      controlSessionBindingSha256: admittedInput.controlSessionBindingSha256,
      operation: admittedInput.operation,
      requestSha256: await requestDigest(admittedInput, issuer, audience),
      sequence: sequence.toString(),
    };
    const header = {
      alg: "Ed25519",
      kid,
      typ: WORKER_LEASE_AUTHORIZATION_TYPE,
    };
    const protectedHeader = encodeBase64Url(
      new TextEncoder().encode(canonicalJson(header)),
    );
    const encodedPayload = encodeBase64Url(
      new TextEncoder().encode(canonicalJson(payload)),
    );
    const signingInput = protectedHeader + "." + encodedPayload;
    const signature = await crypto.subtle.sign(
      "Ed25519",
      input.privateKey,
      new TextEncoder().encode(signingInput).buffer,
    );
    const compactJws =
      signingInput + "." + encodeBase64Url(new Uint8Array(signature));
    if (new TextEncoder().encode(compactJws).byteLength >
      MAXIMUM_WORKER_LEASE_AUTHORIZATION_BYTES) {
      throw invalidAuthorization();
    }
    return compactJws;
  } catch {
    throw invalidAuthorization();
  }
}

/** Verifies strict syntax, binding, role trust, and Ed25519 signature. */
export async function verifyWorkerLeaseAuthorization(
  authorization: unknown,
  input: WorkerLeaseAuthorizationInput,
  trust: WorkLeaseAuthorityTrust,
): Promise<VerifiedWorkerLeaseAuthorization> {
  try {
    if (
      typeof authorization !== "string" ||
      new TextEncoder().encode(authorization).byteLength >
        MAXIMUM_WORKER_LEASE_AUTHORIZATION_BYTES
    ) {
      throw invalidAuthorization();
    }
    const admittedInput = parseAuthorizationInput(structuredClone(input));
    const admittedTrust = parseWorkLeaseAuthorityTrust(structuredClone(trust));
    const [protectedHeader, encodedPayload, encodedSignature, maybeExtra] =
      authorization.split(".");
    if (!protectedHeader || !encodedPayload || !encodedSignature || maybeExtra) {
      throw invalidAuthorization();
    }
    const headerBytes = decodeBase64Url(
      protectedHeader,
      512,
      invalidAuthorization().message,
    );
    const payloadBytes = decodeBase64Url(
      encodedPayload,
      512,
      invalidAuthorization().message,
    );
    const signature = decodeBase64Url(
      encodedSignature,
      86,
      invalidAuthorization().message,
    );
    if (
      encodeBase64Url(headerBytes) !== protectedHeader ||
      encodeBase64Url(payloadBytes) !== encodedPayload ||
      encodeBase64Url(signature) !== encodedSignature
    ) {
      throw invalidAuthorization();
    }
    const header = jsonRecord(
      headerBytes,
      ["alg", "kid", "typ"],
    );
    if (
      header.alg !== "Ed25519" ||
      header.typ !== WORKER_LEASE_AUTHORIZATION_TYPE ||
      typeof header.kid !== "string"
    ) {
      throw invalidAuthorization();
    }
    const kid = parseKeyId(header.kid);
    const payloadText = new TextDecoder("utf-8", { fatal: true }).decode(
      payloadBytes,
    );
    const payload = exactRecord(
      JSON.parse(payloadText),
      [
        "controlSessionBindingSha256",
        "operation",
        "requestSha256",
        "sequence",
      ],
    );
    if (
      !digest(payload.controlSessionBindingSha256) ||
      !operation(payload.operation) ||
      !digest(payload.requestSha256) ||
      typeof payload.sequence !== "string" ||
      payloadText !== canonicalJson(payload)
    ) {
      throw invalidAuthorization();
    }
    const sequence = parseSequence(payload.sequence);
    if (
      payload.operation !== admittedInput.operation ||
      payload.controlSessionBindingSha256 !==
        admittedInput.controlSessionBindingSha256 ||
      payload.requestSha256 !== await requestDigest(
        admittedInput,
        admittedTrust.issuer,
        admittedTrust.audience,
      )
    ) {
      throw invalidAuthorization();
    }
    const matchingKeys = admittedTrust.keys.filter((key) => key.kid === kid);
    const maybeKey = matchingKeys[0];
    if (matchingKeys.length !== 1 || !maybeKey) throw invalidAuthorization();
    const key = await crypto.subtle.importKey(
      "jwk",
      maybeKey,
      "Ed25519",
      false,
      ["verify"],
    );
    if (signature.byteLength !== 64) throw invalidAuthorization();
    const valid = await crypto.subtle.verify(
      "Ed25519",
      key,
      signature.slice().buffer,
      new TextEncoder().encode(protectedHeader + "." + encodedPayload).buffer,
    );
    if (!valid) throw invalidAuthorization();
    return { keyId: kid, sequence };
  } catch {
    throw invalidAuthorization();
  }
}

async function requestDigest(
  input: WorkerLeaseAuthorizationInput,
  issuer: string,
  audience: string,
): Promise<string> {
  return sha256Base64UrlBytes(
    new TextEncoder().encode(canonicalJson({
      profile: WORKER_LEASE_AUTHORIZATION_PROFILE,
      issuer,
      audience,
      operation: input.operation,
      activeChallengeId: input.activeChallengeId,
      request: input.request,
    })),
  );
}

function parseAuthorizationInput(input: unknown): WorkerLeaseAuthorizationInput {
  const value = exactRecord(input, [
    "operation",
    "activeChallengeId",
    "controlSessionBindingSha256",
    "request",
  ]);
  if (
    !operation(value.operation) ||
    !identifier(value.activeChallengeId) ||
    !digest(value.controlSessionBindingSha256)
  ) {
    throw invalidAuthorization();
  }
  if (value.operation === "start") {
    const request = authorizationlessGrant(value.request);
    if (request.challengeId !== value.activeChallengeId) {
      throw invalidAuthorization();
    }
    return {
      operation: value.operation,
      activeChallengeId: value.activeChallengeId,
      controlSessionBindingSha256: value.controlSessionBindingSha256,
      request,
    };
  }
  return {
    operation: value.operation,
    activeChallengeId: value.activeChallengeId,
    controlSessionBindingSha256: value.controlSessionBindingSha256,
    request: authorizationlessRenewal(value.request),
  };
}

function authorizationlessGrant(input: unknown): AuthorizationlessWorkerLeaseGrant {
  const value = exactRecord(input, [
    "protocolVersion",
    "leaseId",
    "challengeId",
    "durationMilliseconds",
    "renewAfterMilliseconds",
    "stratum",
  ], ["acceptanceCampaign"]);
  const parsed = parseWorkerLeaseGrant({
    ...value,
    authorization: "authorization-is-verified-separately",
  });
  const { authorization: _authorization, ...request } = parsed;
  return request;
}

function authorizationlessRenewal(
  input: unknown,
): AuthorizationlessWorkerLeaseRenewal {
  const value = exactRecord(input, [
    "protocolVersion",
    "leaseId",
    "durationMilliseconds",
    "renewAfterMilliseconds",
  ]);
  const parsed = parseWorkerLeaseRenewal({
    ...value,
    authorization: "authorization-is-verified-separately",
  });
  const { authorization: _authorization, ...request } = parsed;
  return request;
}

/** Parses a strict, non-aliased Work Lease Authority trust set. */
export function parseWorkLeaseAuthorityTrust(input: unknown): WorkLeaseAuthorityTrust {
  const value = exactRecord(input, [
    "profile",
    "issuer",
    "audience",
    "role",
    "keys",
  ]);
  if (
    value.profile !== WORKER_DEPLOYMENT_TRUST_PROFILE ||
    value.role !== "work_lease_authority" ||
    !Array.isArray(value.keys) ||
    value.keys.length === 0 ||
    value.keys.length > 8
  ) {
    throw invalidAuthorization();
  }
  const issuer = parseTrustLabel(value.issuer);
  const audience = parseAudience(value.audience);
  const keys = value.keys.map(parseTrustKey);
  if (new Set(keys.map((key) => key.kid)).size !== keys.length) {
    throw invalidAuthorization();
  }
  if (new Set(keys.map((key) => key.x)).size !== keys.length) {
    throw invalidAuthorization();
  }
  return {
    profile: WORKER_DEPLOYMENT_TRUST_PROFILE,
    issuer,
    audience,
    role: "work_lease_authority",
    keys,
  };
}

function parseTrustKey(input: unknown): WorkLeaseAuthorityJwk {
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
    parseKeyId(value.kid) !== value.kid ||
    value.kty !== "OKP" ||
    value.crv !== "Ed25519" ||
    !isCanonicalPrimeSubgroupEd25519PublicKey(value.x) ||
    value.alg !== "Ed25519" ||
    value.use !== "sig" ||
    !Array.isArray(value.key_ops) ||
    value.key_ops.length !== 1 ||
    value.key_ops[0] !== "verify"
  ) {
    throw invalidAuthorization();
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

function parseSequence(input: string): bigint {
  if (!/^[1-9][0-9]{0,19}$/u.test(input)) throw invalidAuthorization();
  const value = BigInt(input);
  if (value > MAXIMUM_WORKER_LEASE_AUTHORIZATION_SEQUENCE) {
    throw invalidAuthorization();
  }
  return value;
}

function parseKeyId(input: unknown): string {
  if (typeof input !== "string" || !/^[A-Za-z0-9_-]{1,32}$/u.test(input)) {
    throw invalidAuthorization();
  }
  return input;
}

function parseTrustLabel(input: unknown): string {
  if (typeof input !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(input)) {
    throw invalidAuthorization();
  }
  return input;
}

function parseAudience(input: unknown): "bwg-worker-controller/0.4" {
  if (input !== "bwg-worker-controller/0.4") throw invalidAuthorization();
  return input;
}

function assertPrivateSigningKey(key: CryptoKey): void {
  if (
    key.type !== "private" ||
    key.algorithm.name !== "Ed25519" ||
    !key.usages.includes("sign")
  ) {
    throw invalidAuthorization();
  }
}

function exactRecord(
  input: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const value = record(input);
  const actual = Object.keys(value);
  if (
    keys.some((key) => !Object.hasOwn(value, key)) ||
    !actual.every((key) => keys.includes(key) || optional.includes(key))
  ) {
    throw invalidAuthorization();
  }
  return value;
}

function jsonRecord(
  bytes: Uint8Array,
  keys: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  return exactRecord(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    keys,
  );
}

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidAuthorization();
  }
  return input as Record<string, unknown>;
}

function operation(input: unknown): input is WorkerLeaseAuthorizationOperation {
  return input === "start" || input === "renew";
}

function digest(input: unknown): input is string {
  return typeof input === "string" && /^[A-Za-z0-9_-]{43}$/u.test(input);
}

function identifier(input: unknown): input is string {
  return typeof input === "string" &&
    input.length > 0 &&
    input.length <= 128 &&
    /^[A-Za-z0-9_-]+$/u.test(input);
}

function invalidAuthorization(): Error {
  return new Error("Worker Lease authorization is invalid");
}
