import {
  WORKER_CONTROLLER_PROTOCOL_VERSION,
  parseWorkerControllerCapabilities,
  parseWorkerControllerStatus,
  parseWorkerLeaseGrant,
  parseWorkerLeaseRenewal,
  type WorkerControllerCapabilities,
  type WorkerControllerStatus,
  type WorkerLeaseGrant,
  type WorkerLeaseRenewal,
} from "./worker-controller";
import { decodeBase64Url, sha256Base64UrlBytes } from "./crypto-bytes";
import { canonicalJson } from "./headless-values";
import {
  parseWorkerUsbApplicationDescriptor,
  type WorkerUsbApplicationDescriptor,
} from "./worker-usb-profile";

export type SignedWorkerControllerCapabilities<
  Protocol extends string,
  TransportProfile extends string,
> = Omit<WorkerControllerCapabilities, "protocolVersion" | "board"> & {
  protocolVersion: Protocol;
  board: Omit<WorkerControllerCapabilities["board"], "usbTransport"> & {
    usbTransport: "web_usb";
  };
  transportProfile: TransportProfile;
  attestation: WorkerControllerCapabilityAttestation<Protocol, TransportProfile>;
};

export type WorkerControllerCapabilityClaims<
  Protocol extends string,
  TransportProfile extends string,
> = {
  profile: "bwg-reference-firmware-capability/0.1";
  protocolVersion: Protocol;
  board: { model: string; revision: string };
  firmware: { name: string; version: string };
  compatibility: WorkerControllerCapabilities["compatibility"];
  transportProfile: TransportProfile;
  applicationDescriptorSha256: string;
};

export type WorkerControllerCapabilityAttestation<
  Protocol extends string,
  TransportProfile extends string,
> = {
  claims: WorkerControllerCapabilityClaims<Protocol, TransportProfile>;
  compactJws: string;
};

export type VersionedWorkerLeaseGrant<Protocol extends string> = Omit<
  WorkerLeaseGrant,
  "protocolVersion"
> & { protocolVersion: Protocol };

export type VersionedWorkerLeaseRenewal<Protocol extends string> = Omit<
  WorkerLeaseRenewal,
  "protocolVersion"
> & { protocolVersion: Protocol };

export type VersionedWorkerControllerStatus<Protocol extends string> =
  WorkerControllerStatus extends infer Status
    ? Status extends { protocolVersion: string }
      ? Omit<Status, "protocolVersion"> & { protocolVersion: Protocol }
      : never
    : never;

export type SignedWorkerControllerProfile<
  Protocol extends string,
  TransportProfile extends string,
> = {
  protocolVersion: Protocol;
  transportProfile: TransportProfile;
  label: string;
};

export function parseSignedWorkerControllerCapabilities<
  Protocol extends string,
  TransportProfile extends string,
>(
  input: unknown,
  profile: SignedWorkerControllerProfile<Protocol, TransportProfile>,
): SignedWorkerControllerCapabilities<Protocol, TransportProfile> {
  const errorMessage = `${profile.label} capability is invalid`;
  const value = record(input, errorMessage);
  const board = record(value.board, errorMessage);
  if (
    value.protocolVersion !== profile.protocolVersion ||
    value.transportProfile !== profile.transportProfile ||
    board.usbTransport !== "web_usb"
  ) {
    throw new Error(errorMessage);
  }
  const attestation = parseCapabilityAttestation(value.attestation, profile);
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
  const parsed: SignedWorkerControllerCapabilities<Protocol, TransportProfile> = {
    ...semantic,
    protocolVersion: profile.protocolVersion,
    board: { ...semantic.board, usbTransport: "web_usb" },
    transportProfile: profile.transportProfile,
    attestation,
  };
  if (
    canonicalJson(attestation.claims) !== canonicalJson({
      profile: "bwg-reference-firmware-capability/0.1",
      protocolVersion: profile.protocolVersion,
      board: { model: parsed.board.model, revision: parsed.board.revision },
      firmware: parsed.firmware,
      compatibility: parsed.compatibility,
      transportProfile: profile.transportProfile,
      applicationDescriptorSha256: attestation.claims.applicationDescriptorSha256,
    })
  ) {
    throw new Error(errorMessage);
  }
  return parsed;
}

export async function verifySignedWorkerControllerCapability<
  Protocol extends string,
  TransportProfile extends string,
>(
  capability: SignedWorkerControllerCapabilities<Protocol, TransportProfile>,
  descriptor: WorkerUsbApplicationDescriptor,
  trustedKeys: readonly unknown[],
  profile: SignedWorkerControllerProfile<Protocol, TransportProfile>,
): Promise<SignedWorkerControllerCapabilities<Protocol, TransportProfile>> {
  const errorMessage = `${profile.label} capability attestation is invalid`;
  const admittedCapability = parseSignedWorkerControllerCapabilities(
    structuredClone(capability),
    profile,
  );
  const admittedDescriptor = parseWorkerUsbApplicationDescriptor(structuredClone(descriptor));
  const admittedKeys = trustedKeys.map((key) =>
    parseCapabilityVerificationKey(structuredClone(key), errorMessage),
  );
  const compactJws = admittedCapability.attestation.compactJws;
  const [protectedHeader, payload, signature, maybeExtra] = compactJws.split(".");
  if (
    !protectedHeader ||
    protectedHeader.length > 512 ||
    !payload ||
    payload.length > 4_096 ||
    !signature ||
    signature.length !== 86 ||
    maybeExtra
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
  const key = matchingKeys[0];
  if (matchingKeys.length !== 1 || !key) throw new Error(errorMessage);
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

export function parseVersionedWorkerLeaseGrant<Protocol extends string>(
  input: unknown,
  profile: SignedWorkerControllerProfile<Protocol, string>,
): VersionedWorkerLeaseGrant<Protocol> {
  const version = profile.protocolVersion.split("/").at(-1);
  const parsed = parseWorkerLeaseGrant(
    legacyVersion(input, profile, `Work Lease ${String(version)} grant is invalid`),
  );
  return { ...parsed, protocolVersion: profile.protocolVersion };
}

export function parseVersionedWorkerLeaseRenewal<Protocol extends string>(
  input: unknown,
  profile: SignedWorkerControllerProfile<Protocol, string>,
): VersionedWorkerLeaseRenewal<Protocol> {
  const version = profile.protocolVersion.split("/").at(-1);
  const parsed = parseWorkerLeaseRenewal(
    legacyVersion(input, profile, `Work Lease ${String(version)} renewal is invalid`),
  );
  return { ...parsed, protocolVersion: profile.protocolVersion };
}

export function parseVersionedWorkerControllerStatus<Protocol extends string>(
  input: unknown,
  profile: SignedWorkerControllerProfile<Protocol, string>,
): VersionedWorkerControllerStatus<Protocol> {
  const parsed = parseWorkerControllerStatus(
    legacyVersion(input, profile, `${profile.label} status is invalid`),
  );
  return { ...parsed, protocolVersion: profile.protocolVersion } as
    VersionedWorkerControllerStatus<Protocol>;
}

function parseCapabilityAttestation<Protocol extends string, TransportProfile extends string>(
  input: unknown,
  profile: SignedWorkerControllerProfile<Protocol, TransportProfile>,
): WorkerControllerCapabilityAttestation<Protocol, TransportProfile> {
  const errorMessage = `${profile.label} capability is invalid`;
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
    claims.protocolVersion !== profile.protocolVersion ||
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
    claims.transportProfile !== profile.transportProfile ||
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
      protocolVersion: profile.protocolVersion,
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
      transportProfile: profile.transportProfile,
      applicationDescriptorSha256: claims.applicationDescriptorSha256,
    },
    compactJws: value.compactJws,
  };
}

function parseCapabilityVerificationKey(
  input: unknown,
  message: string,
): JsonWebKey & { kid: string } {
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
  const permitted = [...required, ...optional];
  const keys = Object.keys(value);
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
  try {
    return exactRecord(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      keys,
      message,
    );
  } catch {
    throw new Error(message);
  }
}

function record(input: unknown, message: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(message);
  }
  return input as Record<string, unknown>;
}

function validLabel(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._-]+$/u.test(value);
}

function legacyVersion<Protocol extends string>(
  input: unknown,
  profile: SignedWorkerControllerProfile<Protocol, string>,
  message: string,
): Record<string, unknown> {
  const value = record(input, message);
  if (value.protocolVersion !== profile.protocolVersion) throw new Error(message);
  return { ...value, protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION };
}
