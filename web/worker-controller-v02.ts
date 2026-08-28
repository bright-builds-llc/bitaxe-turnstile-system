import {
  WORKER_CONTROLLER_PROTOCOL_VERSION,
  parseWorkerControllerCapabilities,
  parseWorkerControllerStatus,
  parseWorkerLeaseGrant,
  parseWorkerLeaseRenewal,
  type WorkerControllerCapabilities,
  type WorkerControllerContract,
  type WorkerControllerStatus,
  type WorkerLeaseGrant,
  type WorkerLeaseRenewal,
} from "./worker-controller";
import { canonicalJson } from "./headless-values";
import { decodeBase64Url, sha256Base64UrlBytes } from "./crypto-bytes";
import {
  WORKER_USB_PROFILE_VERSION,
  parseWorkerUsbApplicationDescriptor,
  type WorkerUsbApplicationDescriptor,
} from "./worker-usb-profile";

/** Wire profile used by separated application control and evidence transports. */
export const WORKER_CONTROLLER_V02_PROTOCOL_VERSION = "bwg-worker-controller/0.2" as const;

/** Strict signed Reference Firmware capability returned by Controller 0.2. */
export type WorkerControllerCapabilitiesV02 = Omit<
  WorkerControllerCapabilities,
  "protocolVersion" | "board"
> & {
  protocolVersion: typeof WORKER_CONTROLLER_V02_PROTOCOL_VERSION;
  board: Omit<WorkerControllerCapabilities["board"], "usbTransport"> & {
    usbTransport: "web_usb";
  };
  transportProfile: typeof WORKER_USB_PROFILE_VERSION;
  attestation: WorkerControllerCapabilityAttestation;
};

/** Update Authority-signed claims bound to capability and application descriptor bytes. */
export type WorkerControllerCapabilityClaims = {
  profile: "bwg-reference-firmware-capability/0.1";
  protocolVersion: typeof WORKER_CONTROLLER_V02_PROTOCOL_VERSION;
  board: { model: string; revision: string };
  firmware: { name: string; version: string };
  compatibility: WorkerControllerCapabilitiesV02["compatibility"];
  transportProfile: typeof WORKER_USB_PROFILE_VERSION;
  applicationDescriptorSha256: string;
};

/** Compact Update Authority proof for the exact public capability claims. */
export type WorkerControllerCapabilityAttestation = {
  claims: WorkerControllerCapabilityClaims;
  compactJws: string;
};

/** Controller 0.2 specialization of one authenticated bounded lease grant. */
export type WorkerLeaseGrantV02 = Omit<WorkerLeaseGrant, "protocolVersion"> & {
  protocolVersion: typeof WORKER_CONTROLLER_V02_PROTOCOL_VERSION;
};

/** Controller 0.2 specialization of one authenticated bounded renewal. */
export type WorkerLeaseRenewalV02 = Omit<WorkerLeaseRenewal, "protocolVersion"> & {
  protocolVersion: typeof WORKER_CONTROLLER_V02_PROTOCOL_VERSION;
};

type WithV02Protocol<T extends { protocolVersion: string }> = T extends unknown
  ? Omit<T, "protocolVersion"> & {
      protocolVersion: typeof WORKER_CONTROLLER_V02_PROTOCOL_VERSION;
    }
  : never;

/** Metadata-only Controller 0.2 lease and restoration state. */
export type WorkerControllerStatusV02 = WithV02Protocol<WorkerControllerStatus>;

/** Controller 0.2 specialization with the same deep method surface as Controller 0.1. */
export type WorkerControllerV02 = WorkerControllerContract<
  WorkerControllerCapabilitiesV02,
  WorkerLeaseGrantV02,
  WorkerLeaseRenewalV02,
  WorkerControllerStatusV02
>;

/** Parses strict Controller 0.2 capability while reusing the 0.1 semantic invariants. */
export function parseWorkerControllerCapabilitiesV02(
  input: unknown,
): WorkerControllerCapabilitiesV02 {
  const value = record(input, "Worker Controller 0.2 capability is invalid");
  const board = record(value.board, "Worker Controller 0.2 capability is invalid");
  if (
    value.protocolVersion !== WORKER_CONTROLLER_V02_PROTOCOL_VERSION ||
    value.transportProfile !== WORKER_USB_PROFILE_VERSION ||
    board.usbTransport !== "web_usb"
  ) {
    throw new Error("Worker Controller 0.2 capability is invalid");
  }
  const attestation = parseCapabilityAttestation(value.attestation);
  const {
    transportProfile: _transportProfile,
    attestation: _attestation,
    ...withoutTransportProfile
  } = value;
  const semantic = parseWorkerControllerCapabilities({
    ...withoutTransportProfile,
    protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION,
    board: { ...board, usbTransport: "web_serial" },
  });
  const parsed: WorkerControllerCapabilitiesV02 = {
    ...semantic,
    protocolVersion: WORKER_CONTROLLER_V02_PROTOCOL_VERSION,
    board: { ...semantic.board, usbTransport: "web_usb" },
    transportProfile: WORKER_USB_PROFILE_VERSION,
    attestation,
  };
  if (
    canonicalJson(attestation.claims) !==
    canonicalJson({
      profile: "bwg-reference-firmware-capability/0.1",
      protocolVersion: WORKER_CONTROLLER_V02_PROTOCOL_VERSION,
      board: { model: parsed.board.model, revision: parsed.board.revision },
      firmware: parsed.firmware,
      compatibility: parsed.compatibility,
      transportProfile: WORKER_USB_PROFILE_VERSION,
      applicationDescriptorSha256: attestation.claims.applicationDescriptorSha256,
    })
  ) {
    throw new Error("Worker Controller 0.2 capability is invalid");
  }
  return parsed;
}

/** Verifies Update Authority signature and exact descriptor binding before admission. */
export async function verifyWorkerControllerCapabilityV02(
  capability: WorkerControllerCapabilitiesV02,
  descriptor: WorkerUsbApplicationDescriptor,
  trustedKeys: readonly unknown[],
): Promise<WorkerControllerCapabilitiesV02> {
  const errorMessage = "Worker Controller 0.2 capability attestation is invalid";
  const admittedCapability = parseWorkerControllerCapabilitiesV02(structuredClone(capability));
  const admittedDescriptor = parseWorkerUsbApplicationDescriptor(structuredClone(descriptor));
  const admittedKeys = trustedKeys.map((key) =>
    parseCapabilityVerificationKey(structuredClone(key), errorMessage),
  );
  const compactJws = admittedCapability.attestation.compactJws;
  const [protectedHeader, payload, signature, extra] = compactJws.split(".");
  if (
    !protectedHeader ||
    protectedHeader.length > 512 ||
    !payload ||
    payload.length > 4_096 ||
    !signature ||
    signature.length !== 86 ||
    extra
  ) {
    throw new Error(errorMessage);
  }
  const header = jsonRecord(
    decodeBase64Url(protectedHeader, 512, errorMessage),
    ["alg", "typ", "kid"],
    errorMessage,
  );
  if (
    header.alg !== "Ed25519" ||
    header.typ !== "bwg-worker-capability+jws" ||
    typeof header.kid !== "string" ||
    !validLabel(header.kid)
  ) {
    throw new Error(errorMessage);
  }
  const matchingKeys = admittedKeys.filter((key) => key.kid === header.kid);
  if (matchingKeys.length !== 1) throw new Error(errorMessage);
  const [key] = matchingKeys;
  if (!key) throw new Error(errorMessage);
  const decodedPayload = new TextDecoder("utf-8", { fatal: true }).decode(
    decodeBase64Url(payload, 4_096, errorMessage),
  );
  if (decodedPayload !== canonicalJson(admittedCapability.attestation.claims)) {
    throw new Error(errorMessage);
  }
  const descriptorDigest = await sha256Base64UrlBytes(
    new TextEncoder().encode(canonicalJson(admittedDescriptor)),
  );
  if (
    !admittedCapability.compatibility.referenceFirmware ||
    descriptorDigest !== admittedCapability.attestation.claims.applicationDescriptorSha256
  ) {
    throw new Error(errorMessage);
  }
  const cryptoKey = await crypto.subtle.importKey("jwk", key, "Ed25519", false, ["verify"]);
  const valid = await crypto.subtle.verify(
    "Ed25519",
    cryptoKey,
    decodeBase64Url(signature, 86, errorMessage).slice().buffer,
    new TextEncoder().encode(`${protectedHeader}.${payload}`).buffer,
  );
  if (!valid) throw new Error(errorMessage);
  return admittedCapability;
}

/** Parses Controller 0.2 grant bytes through the unchanged bounded lease semantics. */
export function parseWorkerLeaseGrantV02(input: unknown): WorkerLeaseGrantV02 {
  const parsed = parseWorkerLeaseGrant(legacyVersion(input, "Work Lease 0.2 grant is invalid"));
  return { ...parsed, protocolVersion: WORKER_CONTROLLER_V02_PROTOCOL_VERSION };
}

/** Parses Controller 0.2 renewal bytes through the unchanged bounded lease semantics. */
export function parseWorkerLeaseRenewalV02(input: unknown): WorkerLeaseRenewalV02 {
  const parsed = parseWorkerLeaseRenewal(
    legacyVersion(input, "Work Lease 0.2 renewal is invalid"),
  );
  return { ...parsed, protocolVersion: WORKER_CONTROLLER_V02_PROTOCOL_VERSION };
}

/** Parses Controller 0.2 status while preserving the metadata-only 0.1 invariants. */
export function parseWorkerControllerStatusV02(input: unknown): WorkerControllerStatusV02 {
  const parsed = parseWorkerControllerStatus(
    legacyVersion(input, "Worker Controller 0.2 status is invalid"),
  );
  return { ...parsed, protocolVersion: WORKER_CONTROLLER_V02_PROTOCOL_VERSION };
}

function record(input: unknown, message: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(message);
  }
  return input as Record<string, unknown>;
}

function parseCapabilityAttestation(input: unknown): WorkerControllerCapabilityAttestation {
  const errorMessage = "Worker Controller 0.2 capability is invalid";
  const value = exactRecord(input, ["claims", "compactJws"], errorMessage);
  const claims = exactRecord(
    value.claims,
    [
      "profile",
      "protocolVersion",
      "board",
      "firmware",
      "compatibility",
      "transportProfile",
      "applicationDescriptorSha256",
    ],
    errorMessage,
  );
  const board = exactRecord(claims.board, ["model", "revision"], errorMessage);
  const firmware = exactRecord(claims.firmware, ["name", "version"], errorMessage);
  const compatibility = exactRecord(
    claims.compatibility,
    ["referenceFirmware", "workLease", "miningBaselineRestoration", "settingsPreservation"],
    errorMessage,
  );
  if (
    claims.profile !== "bwg-reference-firmware-capability/0.1" ||
    claims.protocolVersion !== WORKER_CONTROLLER_V02_PROTOCOL_VERSION ||
    typeof board.model !== "string" ||
    !validLabel(board.model) ||
    typeof board.revision !== "string" ||
    !validLabel(board.revision) ||
    typeof firmware.name !== "string" ||
    !validLabel(firmware.name) ||
    typeof firmware.version !== "string" ||
    !validLabel(firmware.version) ||
    typeof compatibility.referenceFirmware !== "boolean" ||
    compatibility.workLease !== "supported" ||
    compatibility.miningBaselineRestoration !== "supported" ||
    !["compatible", "upgrade_required", "unsupported"].includes(
      String(compatibility.settingsPreservation),
    ) ||
    claims.transportProfile !== WORKER_USB_PROFILE_VERSION ||
    typeof claims.applicationDescriptorSha256 !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(claims.applicationDescriptorSha256) ||
    typeof value.compactJws !== "string" ||
    value.compactJws.length === 0 ||
    value.compactJws.length > 8_192
  ) {
    throw new Error(errorMessage);
  }
  return {
    claims: {
      profile: "bwg-reference-firmware-capability/0.1",
      protocolVersion: WORKER_CONTROLLER_V02_PROTOCOL_VERSION,
      board: { model: board.model, revision: board.revision },
      firmware: { name: firmware.name, version: firmware.version },
      compatibility: {
        referenceFirmware: compatibility.referenceFirmware,
        workLease: "supported",
        miningBaselineRestoration: "supported",
        settingsPreservation: compatibility.settingsPreservation as
          | "compatible"
          | "upgrade_required"
          | "unsupported",
      },
      transportProfile: WORKER_USB_PROFILE_VERSION,
      applicationDescriptorSha256: claims.applicationDescriptorSha256,
    },
    compactJws: value.compactJws,
  };
}

function parseCapabilityVerificationKey(input: unknown, message: string): JsonWebKey & {
  kid: string;
} {
  const key = exactRecord(
    input,
    ["kty", "crv", "x", "kid", "alg", "use", "key_ops"],
    message,
    ["ext"],
  );
  if (
    "d" in key ||
    key.kty !== "OKP" ||
    key.crv !== "Ed25519" ||
    typeof key.x !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(key.x) ||
    typeof key.kid !== "string" ||
    !validLabel(key.kid) ||
    key.alg !== "Ed25519" ||
    key.use !== "sig" ||
    !Array.isArray(key.key_ops) ||
    key.key_ops.length !== 1 ||
    key.key_ops[0] !== "verify" ||
    (key.ext !== undefined && typeof key.ext !== "boolean")
  ) {
    throw new Error(message);
  }
  return {
    kty: "OKP",
    crv: "Ed25519",
    x: key.x,
    kid: key.kid,
    alg: "Ed25519",
    use: "sig",
    key_ops: ["verify"],
    ...(key.ext === undefined ? {} : { ext: key.ext }),
  };
}

function exactRecord(
  input: unknown,
  required: readonly string[],
  message: string,
  optional: readonly string[] = [],
): Record<string, unknown> {
  const value = record(input, message);
  const keys = Object.keys(value);
  const permitted = [...required, ...optional];
  if (
    keys.some((key) => !permitted.includes(key)) ||
    required.some((key) => !keys.includes(key))
  ) {
    throw new Error(message);
  }
  return value;
}

function jsonRecord(
  bytes: Uint8Array,
  keys: readonly string[],
  message: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(message);
  }
  return exactRecord(parsed, keys, message);
}

function validLabel(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._-]+$/u.test(value);
}

function legacyVersion(input: unknown, message: string): Record<string, unknown> {
  const value = record(input, message);
  if (value.protocolVersion !== WORKER_CONTROLLER_V02_PROTOCOL_VERSION) {
    throw new Error(message);
  }
  return { ...value, protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION };
}
