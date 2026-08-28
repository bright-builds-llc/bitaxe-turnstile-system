import {
  decodeBase64Url,
  encodeBase64Url,
  sha256Base64UrlBytes,
} from "./crypto-bytes";
import { canonicalJson } from "./headless-values";

/** Independent pre-admission profile carried by the Worker USB 0.2 control function. */
export const WORKER_POSSESSION_PROFILE = "bwg-worker-possession/0.1" as const;
/** Canonical signed-claim profile for one fresh Local Device Possession Proof. */
export const WORKER_POSSESSION_PROOF_PROFILE = "bwg-worker-possession-proof/0.1" as const;

// Canonical compressed encodings of curve25519-dalek's complete EIGHT_TORSION set.
const WEAK_ED25519_PUBLIC_KEYS = new Set([
  "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "xxdqcD1N2E-6PAt2DRBnDyogU_osOczGTsf9d5KsA3o",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIA",
  "JuiVj8KyJ7BFw_SJ8u-Y8NXfrAXTxjM5sTgCiG1T_AU",
  "7P_______________________________________38",
  "JuiVj8KyJ7BFw_SJ8u-Y8NXfrAXTxjM5sTgCiG1T_IU",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "xxdqcD1N2E-6PAt2DRBnDyogU_osOczGTsf9d5KsA_o",
]);

const ED25519_FIELD_PRIME = (1n << 255n) - 19n;
const ED25519_SUBGROUP_ORDER =
  (1n << 252n) + 27742317777372353535851937790883648493n;
const ED25519_D = field(
  -121665n * fieldPower(121666n, ED25519_FIELD_PRIME - 2n),
);
const ED25519_SQRT_M1 = fieldPower(2n, (ED25519_FIELD_PRIME - 1n) / 4n);
const ED25519_IDENTITY: EdwardsPoint = { x: 0n, y: 1n };

type EdwardsPoint = { x: bigint; y: bigint };

/** Closed reason separating first establishment from same-Worker reacquisition. */
export type WorkerPossessionPurpose = "initial_admission" | "transport_reacquisition";

type WorkerPossessionBindingFields = {
  possessionNonce: string;
  challengeBindingSha256: string;
  controllerCapabilitySha256: string;
  applicationDescriptorSha256: string;
};

/** Initial establishment forbids an already trusted Device Identity fingerprint. */
export type InitialWorkerPossessionBinding = WorkerPossessionBindingFields & {
  requestId: string;
  purpose: "initial_admission";
  maybeExpectedDeviceIdentityFingerprint?: never;
};

/** Reacquisition requires the exact previously established Device Identity fingerprint. */
export type ReacquisitionWorkerPossessionBinding = WorkerPossessionBindingFields & {
  requestId: string;
  purpose: "transport_reacquisition";
  expectedDeviceIdentityFingerprint: string;
};

/** Illegal initial/reacquisition fingerprint combinations cannot be constructed. */
export type WorkerPossessionBinding =
  | InitialWorkerPossessionBinding
  | ReacquisitionWorkerPossessionBinding;

/** Strict request sent before any Controller 0.3 Work Lease command. */
export type WorkerPossessionRequest = {
  profile: typeof WORKER_POSSESSION_PROFILE;
  requestId: string;
  command: "prove_possession";
  payload: WorkerPossessionBindingFields & { purpose: WorkerPossessionPurpose };
};

/** Strict public Ed25519 Device Identity key accepted from Reference Firmware. */
export type WorkerDeviceIdentityJwk = {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  alg: "Ed25519";
  use: "sig";
  key_ops: readonly ["verify"];
};

/** Canonical signed possession transcript. */
export type WorkerPossessionClaims = WorkerPossessionRequest["payload"] & {
  profile: typeof WORKER_POSSESSION_PROOF_PROFILE;
  deviceIdentityJwk: WorkerDeviceIdentityJwk;
};

/** Correlated proof response with normalized metadata-only failure. */
export type WorkerPossessionResponse =
  | {
      profile: typeof WORKER_POSSESSION_PROFILE;
      requestId: string;
      ok: true;
      result: { claims: WorkerPossessionClaims; compactJws: string };
    }
  | {
      profile: typeof WORKER_POSSESSION_PROFILE;
      requestId: string;
      ok: false;
      error: { code: "invalid_request" | "proof_unavailable"; message: string };
    };

/** Successful local continuity result retained only inside the browser adapter. */
export type VerifiedWorkerPossession = { deviceIdentityFingerprint: string };

/** One fresh bound transcript whose request and live proof must never be logged or persisted. */
export interface WorkerPossessionChallenge {
  /** Single request to send once over the admitted Worker USB 0.2 control function. */
  readonly request: WorkerPossessionRequest;
  /** Consumes this challenge exactly once, including on failed or concurrent verification. */
  verify(response: unknown): Promise<VerifiedWorkerPossession>;
}

/** Creates one single-use possession challenge from caller-generated cryptographic bindings. */
export function createWorkerPossessionChallenge(
  input: WorkerPossessionBinding,
): WorkerPossessionChallenge {
  const binding = parseBinding(structuredClone(input));
  const request = requestFor(binding);
  let consumed = false;
  return {
    request,
    async verify(response) {
      if (consumed) throw invalidProof();
      consumed = true;
      try {
        return await verifyResponse(binding, structuredClone(response));
      } catch {
        throw invalidProof();
      }
    },
  };
}

/** Parses one untrusted possession request into the exact closed wire shape. */
export function parseWorkerPossessionRequest(input: unknown): WorkerPossessionRequest {
  try {
    const value = exactRecord(input, ["profile", "requestId", "command", "payload"]);
    if (
      value.profile !== WORKER_POSSESSION_PROFILE ||
      value.command !== "prove_possession"
    ) {
      throw invalidRequest();
    }
    const payload = exactRecord(value.payload, [
      "purpose",
      "possessionNonce",
      "challengeBindingSha256",
      "controllerCapabilitySha256",
      "applicationDescriptorSha256",
    ]);
    if (
      typeof value.requestId !== "string" ||
      !validRequestId(value.requestId) ||
      !validPurpose(payload.purpose) ||
      !digest(payload.possessionNonce) ||
      !digest(payload.challengeBindingSha256) ||
      !digest(payload.controllerCapabilitySha256) ||
      !digest(payload.applicationDescriptorSha256)
    ) {
      throw invalidRequest();
    }
    return {
      profile: WORKER_POSSESSION_PROFILE,
      requestId: value.requestId,
      command: "prove_possession",
      payload: {
        purpose: payload.purpose,
        possessionNonce: payload.possessionNonce,
        challengeBindingSha256: payload.challengeBindingSha256,
        controllerCapabilitySha256: payload.controllerCapabilitySha256,
        applicationDescriptorSha256: payload.applicationDescriptorSha256,
      },
    };
  } catch {
    throw invalidRequest();
  }
}

/** Parses one untrusted correlated proof response and normalizes failure text. */
export function parseWorkerPossessionResponse(input: unknown): WorkerPossessionResponse {
  return parseResponse(input);
}

async function verifyResponse(
  binding: WorkerPossessionBinding,
  input: unknown,
): Promise<VerifiedWorkerPossession> {
  const response = parseResponse(input);
  if (response.requestId !== binding.requestId || !response.ok) throw invalidProof();
  const claims = parseClaims(response.result.claims);
  const expectedClaims: WorkerPossessionClaims = {
    profile: WORKER_POSSESSION_PROOF_PROFILE,
    purpose: binding.purpose,
    possessionNonce: binding.possessionNonce,
    challengeBindingSha256: binding.challengeBindingSha256,
    controllerCapabilitySha256: binding.controllerCapabilitySha256,
    applicationDescriptorSha256: binding.applicationDescriptorSha256,
    deviceIdentityJwk: claims.deviceIdentityJwk,
  };
  if (canonicalJson(claims) !== canonicalJson(expectedClaims)) throw invalidProof();

  const [protectedHeader, payload, signature, maybeExtra] = response.result.compactJws.split(".");
  if (
    !protectedHeader ||
    protectedHeader.length > 512 ||
    !payload ||
    payload.length > 4_096 ||
    !signature ||
    signature.length !== 86 ||
    maybeExtra
  ) {
    throw invalidProof();
  }
  const header = jsonRecord(decodeBase64Url(protectedHeader, 512, invalidProof().message));
  if (
    Object.keys(header).length !== 2 ||
    header.alg !== "Ed25519" ||
    header.typ !== "bwg-worker-possession+jws"
  ) {
    throw invalidProof();
  }
  const decodedPayload = new TextDecoder("utf-8", { fatal: true }).decode(
    decodeBase64Url(payload, 4_096, invalidProof().message),
  );
  if (decodedPayload !== canonicalJson(claims)) throw invalidProof();

  const verificationJwk: JsonWebKey = {
    kty: claims.deviceIdentityJwk.kty,
    crv: claims.deviceIdentityJwk.crv,
    x: claims.deviceIdentityJwk.x,
    alg: claims.deviceIdentityJwk.alg,
    use: claims.deviceIdentityJwk.use,
    key_ops: ["verify"],
  };
  const key = await crypto.subtle.importKey(
    "jwk",
    verificationJwk,
    "Ed25519",
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "Ed25519",
    key,
    decodeBase64Url(signature, 86, invalidProof().message).slice().buffer,
    new TextEncoder().encode(`${protectedHeader}.${payload}`).buffer,
  );
  if (!valid) throw invalidProof();

  const deviceIdentityFingerprint = await sha256Base64UrlBytes(
    new TextEncoder().encode(canonicalJson(claims.deviceIdentityJwk)),
  );
  if (
    binding.purpose === "transport_reacquisition" &&
    binding.expectedDeviceIdentityFingerprint !== deviceIdentityFingerprint
  ) {
    throw invalidProof();
  }
  return { deviceIdentityFingerprint };
}

function requestFor(binding: WorkerPossessionBinding): WorkerPossessionRequest {
  return {
    profile: WORKER_POSSESSION_PROFILE,
    requestId: binding.requestId,
    command: "prove_possession",
    payload: {
      purpose: binding.purpose,
      possessionNonce: binding.possessionNonce,
      challengeBindingSha256: binding.challengeBindingSha256,
      controllerCapabilitySha256: binding.controllerCapabilitySha256,
      applicationDescriptorSha256: binding.applicationDescriptorSha256,
    },
  };
}

function parseBinding(input: unknown): WorkerPossessionBinding {
  const value = exactRecord(
    input,
    [
      "requestId",
      "purpose",
      "possessionNonce",
      "challengeBindingSha256",
      "controllerCapabilitySha256",
      "applicationDescriptorSha256",
    ],
    ["expectedDeviceIdentityFingerprint"],
  );
  if (
    typeof value.requestId !== "string" ||
    !validRequestId(value.requestId) ||
    !validPurpose(value.purpose) ||
    !digest(value.possessionNonce) ||
    !digest(value.challengeBindingSha256) ||
    !digest(value.controllerCapabilitySha256) ||
    !digest(value.applicationDescriptorSha256) ||
    (value.expectedDeviceIdentityFingerprint !== undefined &&
      !digest(value.expectedDeviceIdentityFingerprint)) ||
    (value.purpose === "initial_admission" &&
      value.expectedDeviceIdentityFingerprint !== undefined) ||
    (value.purpose === "transport_reacquisition" &&
      !digest(value.expectedDeviceIdentityFingerprint))
  ) {
    throw invalidRequest();
  }
  const fields = {
    requestId: value.requestId,
    possessionNonce: value.possessionNonce,
    challengeBindingSha256: value.challengeBindingSha256,
    controllerCapabilitySha256: value.controllerCapabilitySha256,
    applicationDescriptorSha256: value.applicationDescriptorSha256,
  };
  if (value.purpose === "initial_admission") {
    return { ...fields, purpose: value.purpose };
  }
  const expectedDeviceIdentityFingerprint = value.expectedDeviceIdentityFingerprint;
  if (!digest(expectedDeviceIdentityFingerprint)) throw invalidRequest();
  return {
    ...fields,
    purpose: value.purpose,
    expectedDeviceIdentityFingerprint,
  };
}

function parseResponse(input: unknown): WorkerPossessionResponse {
  const envelope = record(input);
  if (
    envelope.profile !== WORKER_POSSESSION_PROFILE ||
    typeof envelope.requestId !== "string" ||
    !/^pos_[A-Za-z0-9_-]{1,124}$/u.test(envelope.requestId) ||
    typeof envelope.ok !== "boolean"
  ) {
    throw invalidProof();
  }
  const value = exactRecord(
    envelope,
    envelope.ok
      ? ["profile", "requestId", "ok", "result"]
      : ["profile", "requestId", "ok", "error"],
  );
  if (envelope.ok) {
    const result = exactRecord(value.result, ["claims", "compactJws"]);
    if (typeof result.compactJws !== "string" || result.compactJws.length > 8_192) {
      throw invalidProof();
    }
    return {
      profile: WORKER_POSSESSION_PROFILE,
      requestId: envelope.requestId,
      ok: true,
      result: { claims: parseClaims(result.claims), compactJws: result.compactJws },
    };
  }
  const error = exactRecord(value.error, ["code", "message"]);
  if (
    typeof error.code !== "string" ||
    !["invalid_request", "proof_unavailable"].includes(error.code) ||
    typeof error.message !== "string" ||
    error.message.length === 0 ||
    error.message.length > 256
  ) {
    throw invalidProof();
  }
  return {
    profile: WORKER_POSSESSION_PROFILE,
    requestId: envelope.requestId,
    ok: false,
    error: {
      code: error.code as "invalid_request" | "proof_unavailable",
      message: "Worker possession proof was unavailable",
    },
  };
}

function parseClaims(input: unknown): WorkerPossessionClaims {
  const value = exactRecord(input, [
    "profile",
    "purpose",
    "possessionNonce",
    "challengeBindingSha256",
    "controllerCapabilitySha256",
    "applicationDescriptorSha256",
    "deviceIdentityJwk",
  ]);
  const key = exactRecord(value.deviceIdentityJwk, [
    "kty",
    "crv",
    "x",
    "alg",
    "use",
    "key_ops",
  ]);
  if (
    value.profile !== WORKER_POSSESSION_PROOF_PROFILE ||
    !validPurpose(value.purpose) ||
    !digest(value.possessionNonce) ||
    !digest(value.challengeBindingSha256) ||
    !digest(value.controllerCapabilitySha256) ||
    !digest(value.applicationDescriptorSha256) ||
    key.kty !== "OKP" ||
    key.crv !== "Ed25519" ||
    !canonicalEd25519PublicKey(key.x) ||
    WEAK_ED25519_PUBLIC_KEYS.has(key.x) ||
    key.alg !== "Ed25519" ||
    key.use !== "sig" ||
    !Array.isArray(key.key_ops) ||
    key.key_ops.length !== 1 ||
    key.key_ops[0] !== "verify"
  ) {
    throw invalidProof();
  }
  return {
    profile: WORKER_POSSESSION_PROOF_PROFILE,
    purpose: value.purpose,
    possessionNonce: value.possessionNonce,
    challengeBindingSha256: value.challengeBindingSha256,
    controllerCapabilitySha256: value.controllerCapabilitySha256,
    applicationDescriptorSha256: value.applicationDescriptorSha256,
    deviceIdentityJwk: {
      kty: "OKP",
      crv: "Ed25519",
      x: key.x,
      alg: "Ed25519",
      use: "sig",
      key_ops: ["verify"],
    },
  };
}

function validPurpose(input: unknown): input is WorkerPossessionPurpose {
  return input === "initial_admission" || input === "transport_reacquisition";
}

function validRequestId(input: string): boolean {
  return /^pos_[A-Za-z0-9_-]{1,124}$/u.test(input);
}

function digest(input: unknown): input is string {
  return typeof input === "string" && /^[A-Za-z0-9_-]{43}$/u.test(input);
}

function canonicalEd25519PublicKey(input: unknown): input is string {
  if (!digest(input)) return false;
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64Url(input, 43, invalidProof().message);
  } catch {
    return false;
  }
  if (bytes.byteLength !== 32 || encodeBase64Url(bytes) !== input) return false;

  const encoded = littleEndianInteger(bytes);
  const sign = encoded >> 255n;
  const y = encoded & ((1n << 255n) - 1n);
  if (y >= ED25519_FIELD_PRIME) return false;
  const maybePoint = maybeDecompressEd25519(y, sign);
  if (!maybePoint || pointsEqual(maybePoint, ED25519_IDENTITY)) return false;
  return pointsEqual(scalarMultiply(maybePoint, ED25519_SUBGROUP_ORDER), ED25519_IDENTITY);
}

function maybeDecompressEd25519(y: bigint, sign: bigint): EdwardsPoint | undefined {
  const ySquared = field(y * y);
  const numerator = field(ySquared - 1n);
  const denominator = field(ED25519_D * ySquared + 1n);
  const xSquared = field(
    numerator * fieldPower(denominator, ED25519_FIELD_PRIME - 2n),
  );
  let x = fieldPower(xSquared, (ED25519_FIELD_PRIME + 3n) / 8n);
  if (field(x * x) !== xSquared) x = field(x * ED25519_SQRT_M1);
  if (field(x * x) !== xSquared) return undefined;
  if (x === 0n && sign === 1n) return undefined;
  if ((x & 1n) !== sign) x = field(-x);
  return { x, y };
}

function scalarMultiply(point: EdwardsPoint, scalar: bigint): EdwardsPoint {
  let result = ED25519_IDENTITY;
  let addend = point;
  let remaining = scalar;
  while (remaining > 0n) {
    if ((remaining & 1n) === 1n) result = addPoints(result, addend);
    addend = addPoints(addend, addend);
    remaining >>= 1n;
  }
  return result;
}

function addPoints(left: EdwardsPoint, right: EdwardsPoint): EdwardsPoint {
  const product = field(ED25519_D * left.x * right.x * left.y * right.y);
  const xNumerator = field(left.x * right.y + left.y * right.x);
  const yNumerator = field(left.y * right.y + left.x * right.x);
  return {
    x: field(
      xNumerator * fieldPower(field(1n + product), ED25519_FIELD_PRIME - 2n),
    ),
    y: field(
      yNumerator * fieldPower(field(1n - product), ED25519_FIELD_PRIME - 2n),
    ),
  };
}

function pointsEqual(left: EdwardsPoint, right: EdwardsPoint): boolean {
  return left.x === right.x && left.y === right.y;
}

function littleEndianInteger(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    const byte = bytes[index];
    if (byte === undefined) return 0n;
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

function field(value: bigint): bigint {
  const reduced = value % ED25519_FIELD_PRIME;
  return reduced < 0n ? reduced + ED25519_FIELD_PRIME : reduced;
}

function fieldPower(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let factor = field(base);
  let remaining = exponent;
  while (remaining > 0n) {
    if ((remaining & 1n) === 1n) result = field(result * factor);
    factor = field(factor * factor);
    remaining >>= 1n;
  }
  return result;
}

function jsonRecord(bytes: Uint8Array): Record<string, unknown> {
  try {
    return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch {
    throw invalidProof();
  }
}

function exactRecord(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const value = record(input);
  const permitted = [...required, ...optional];
  if (
    Object.keys(value).some((key) => !permitted.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  ) {
    throw invalidProof();
  }
  return value;
}

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidProof();
  }
  return input as Record<string, unknown>;
}

function invalidRequest(): Error {
  return new Error("Worker possession request is invalid");
}

function invalidProof(): Error {
  return new Error("Worker possession proof is invalid");
}
