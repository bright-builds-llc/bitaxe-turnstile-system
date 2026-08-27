import { canonicalJson } from "./headless-values";
import type { BitaxeDeviceSnapshot } from "./bitaxe-onboarding";
import {
  decodeBase64Url,
  sha256Base64UrlBytes,
} from "./crypto-bytes";

/** Maximum admitted firmware-image size for the bounded browser workflow. */
export const MAXIMUM_FIRMWARE_IMAGE_BYTES = 8_388_608;

/** Update Authority verification key accepted for firmware manifests only. */
export type UpdateAuthorityJwk = JsonWebKey & {
  kid: string;
  alg: "Ed25519";
  use: "sig";
  key_ops: readonly ["verify"];
};

/** Exact signed admission facts for one Reference Firmware image. */
export type FirmwareManifest = {
  profile: "bwg-reference-firmware/0.1";
  firmwareVersion: string;
  imageSha256: string;
  compatibleBoards: readonly { model: string; revisions: readonly string[] }[];
  partition: {
    scheme: "esp32-ota-ab";
    minimumAppSlotBytes: number;
    rollbackRequired: true;
  };
  settingsSchema: { minimumReadable: number; maximumReadable: number; target: number };
  sourceUrl: string;
};

/** Manifest, exact image bytes, and compact Update Authority signature. */
export type FirmwarePackage = {
  manifest: FirmwareManifest;
  image: Uint8Array;
  signature: string;
};

export async function admitFirmwarePackage(
  firmwarePackage: unknown,
  trustedKeys: readonly UpdateAuthorityJwk[],
  snapshot: BitaxeDeviceSnapshot,
): Promise<{ manifest: FirmwareManifest; image: Uint8Array }> {
  const { manifest, image, signature } = parseFirmwarePackage(firmwarePackage);
  const trustedKeySnapshot = trustedKeys.map(parseUpdateAuthorityKey);
  const compact = parseCompactJws(signature);
  const header = parseJsonRecord(
    decodeBase64Url(compact.header, 512, "firmware manifest signature is invalid"),
  );
  if (
    !hasExactKeys(header, ["alg", "typ", "kid"]) ||
    header.alg !== "Ed25519" ||
    header.typ !== "bwg-firmware-manifest+jws" ||
    typeof header.kid !== "string" ||
    !validBoundedLabel(header.kid, 128)
  ) {
    throw new Error("firmware manifest signature is invalid");
  }
  const keys = trustedKeySnapshot.filter((key) => key.kid === header.kid);
  if (keys.length !== 1) throw new Error("firmware manifest signature is invalid");
  const key = keys[0];
  if (!key) throw new Error("firmware manifest signature is invalid");
  const payload = new TextDecoder().decode(
    decodeBase64Url(compact.payload, 130_000, "firmware manifest signature is invalid"),
  );
  if (payload !== canonicalJson(manifest)) {
    throw new Error("firmware manifest signature is invalid");
  }
  const cryptoKey = await crypto.subtle.importKey("jwk", key, "Ed25519", false, ["verify"]);
  const valid = await crypto.subtle.verify(
    "Ed25519",
    cryptoKey,
    decodeBase64Url(
      compact.signature,
      86,
      "firmware manifest signature is invalid",
    ).slice().buffer,
    new TextEncoder().encode(`${compact.header}.${compact.payload}`).buffer,
  );
  if (!valid) throw new Error("firmware manifest signature is invalid");
  if ((await sha256Base64UrlBytes(image)) !== manifest.imageSha256) {
    throw new Error("firmware image digest is invalid");
  }
  if (!compatible(manifest, snapshot)) {
    throw new Error("firmware package is not safely compatible");
  }
  return { manifest, image };
}

function compatible(manifest: FirmwareManifest, snapshot: BitaxeDeviceSnapshot): boolean {
  const board = manifest.compatibleBoards.some(
    (candidate) =>
      candidate.model === snapshot.capabilities.board.model &&
      candidate.revisions.includes(snapshot.capabilities.board.revision),
  );
  return (
    board &&
    snapshot.capabilities.compatibility.settingsPreservation !== "unsupported" &&
    snapshot.partition.bootable &&
    manifest.partition.scheme === snapshot.partition.scheme &&
    manifest.partition.minimumAppSlotBytes <= snapshot.partition.appSlotBytes &&
    (!manifest.partition.rollbackRequired || snapshot.partition.rollbackAvailable) &&
    snapshot.settingsSchemaVersion >= manifest.settingsSchema.minimumReadable &&
    snapshot.settingsSchemaVersion <= manifest.settingsSchema.maximumReadable
  );
}

function parseFirmwarePackage(input: unknown): {
  manifest: FirmwareManifest;
  image: Uint8Array;
  signature: string;
} {
  if (!hasExactKeys(input, ["manifest", "image", "signature"])) {
    throw new Error("firmware package is invalid");
  }
  const value = input as Record<string, unknown>;
  if (!(value.image instanceof Uint8Array)) {
    throw new Error("firmware image is invalid");
  }
  const image = value.image.slice();
  if (image.byteLength === 0 || image.byteLength > MAXIMUM_FIRMWARE_IMAGE_BYTES) {
    throw new Error("firmware image size is invalid");
  }
  if (typeof value.signature !== "string" || value.signature.length > 131_072) {
    throw new Error("firmware manifest signature is invalid");
  }
  return {
    manifest: parseManifest(value.manifest),
    image,
    signature: value.signature,
  };
}

function parseManifest(input: unknown): FirmwareManifest {
  if (
    !hasExactKeys(input, [
      "profile",
      "firmwareVersion",
      "imageSha256",
      "compatibleBoards",
      "partition",
      "settingsSchema",
      "sourceUrl",
    ])
  ) {
    throw new Error("firmware manifest is invalid");
  }
  const value = input as Record<string, unknown>;
  if (
    !hasExactKeys(value.partition, ["scheme", "minimumAppSlotBytes", "rollbackRequired"]) ||
    !hasExactKeys(value.settingsSchema, ["minimumReadable", "maximumReadable", "target"]) ||
    value.profile !== "bwg-reference-firmware/0.1" ||
    typeof value.firmwareVersion !== "string" ||
    value.firmwareVersion.length > 64 ||
    !/^\d+\.\d+\.\d+$/u.test(value.firmwareVersion) ||
    typeof value.imageSha256 !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(value.imageSha256) ||
    !Array.isArray(value.compatibleBoards) ||
    value.compatibleBoards.length === 0 ||
    value.compatibleBoards.length > 32 ||
    typeof value.sourceUrl !== "string" ||
    value.sourceUrl.length > 2_048 ||
    !validHttpsUrl(value.sourceUrl)
  ) {
    throw new Error("firmware manifest is invalid");
  }
  const compatibleBoards = value.compatibleBoards.map(parseCompatibleBoard);
  const partition = value.partition as Record<string, unknown>;
  const settingsSchema = value.settingsSchema as Record<string, unknown>;
  if (
    partition.scheme !== "esp32-ota-ab" ||
    !Number.isSafeInteger(partition.minimumAppSlotBytes) ||
    Number(partition.minimumAppSlotBytes) <= 0 ||
    partition.rollbackRequired !== true ||
    !Number.isSafeInteger(settingsSchema.minimumReadable) ||
    !Number.isSafeInteger(settingsSchema.maximumReadable) ||
    !Number.isSafeInteger(settingsSchema.target) ||
    Number(settingsSchema.minimumReadable) <= 0 ||
    Number(settingsSchema.minimumReadable) > Number(settingsSchema.maximumReadable) ||
    Number(settingsSchema.target) < Number(settingsSchema.minimumReadable) ||
    Number(settingsSchema.target) > Number(settingsSchema.maximumReadable)
  ) {
    throw new Error("firmware manifest is invalid");
  }
  return {
    profile: "bwg-reference-firmware/0.1",
    firmwareVersion: value.firmwareVersion,
    imageSha256: value.imageSha256,
    compatibleBoards,
    partition: {
      scheme: "esp32-ota-ab",
      minimumAppSlotBytes: Number(partition.minimumAppSlotBytes),
      rollbackRequired: true,
    },
    settingsSchema: {
      minimumReadable: Number(settingsSchema.minimumReadable),
      maximumReadable: Number(settingsSchema.maximumReadable),
      target: Number(settingsSchema.target),
    },
    sourceUrl: value.sourceUrl,
  };
}

function parseCompatibleBoard(input: unknown): { model: string; revisions: readonly string[] } {
  if (!hasExactKeys(input, ["model", "revisions"])) {
    throw new Error("firmware manifest is invalid");
  }
  const value = input as Record<string, unknown>;
  if (
    typeof value.model !== "string" ||
    !validBoundedLabel(value.model, 64) ||
    !Array.isArray(value.revisions) ||
    value.revisions.length === 0 ||
    value.revisions.length > 32 ||
    value.revisions.some(
      (revision) => typeof revision !== "string" || !validBoundedLabel(revision, 64),
    )
  ) {
    throw new Error("firmware manifest is invalid");
  }
  return { model: value.model, revisions: [...value.revisions] as string[] };
}

function parseUpdateAuthorityKey(input: unknown): UpdateAuthorityJwk {
  if (
    !hasExactKeys(input, ["kty", "crv", "x", "kid", "alg", "use", "key_ops"], ["ext"])
  ) {
    throw new Error("firmware manifest signature is invalid");
  }
  const value = input as Record<string, unknown>;
  if (
    "d" in value ||
    value.kty !== "OKP" ||
    value.crv !== "Ed25519" ||
    typeof value.x !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(value.x) ||
    typeof value.kid !== "string" ||
    !validBoundedLabel(value.kid, 128) ||
    value.alg !== "Ed25519" ||
    value.use !== "sig" ||
    !Array.isArray(value.key_ops) ||
    value.key_ops.length !== 1 ||
    value.key_ops[0] !== "verify" ||
    (value.ext !== undefined && typeof value.ext !== "boolean")
  ) {
    throw new Error("firmware manifest signature is invalid");
  }
  return {
    kty: "OKP",
    crv: "Ed25519",
    x: value.x,
    kid: value.kid,
    alg: "Ed25519",
    use: "sig",
    key_ops: ["verify"],
    ...(value.ext === undefined ? {} : { ext: value.ext }),
  };
}

function parseCompactJws(value: string): { header: string; payload: string; signature: string } {
  const [header, payload, signature, extra] = value.split(".");
  if (
    !header ||
    header.length > 512 ||
    !payload ||
    payload.length > 130_000 ||
    !signature ||
    signature.length !== 86 ||
    extra
  ) {
    throw new Error("firmware manifest signature is invalid");
  }
  return { header, payload, signature };
}

function parseJsonRecord(value: Uint8Array): Record<string, unknown> {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(value));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("firmware manifest signature is invalid");
  }
  return parsed as Record<string, unknown>;
}

function validHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function validBoundedLabel(value: string, maximumLength: number): boolean {
  return value.length > 0 && value.length <= maximumLength && /^[A-Za-z0-9._-]+$/u.test(value);
}

function hasExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const permitted = [...required, ...optional];
  return (
    keys.every((key) => permitted.includes(key)) &&
    required.every((key) => keys.includes(key))
  );
}
