import type {
  FirmwareManifest,
  FirmwarePackage,
  NvsSettingEntry,
  UpdateAuthorityJwk,
} from "./bitaxe-onboarding";
import type { SimulatedBitaxeSnapshot } from "./simulated-bitaxe-onboarding";
import { canonicalJson } from "./headless-values";
import { encodePartitionTable, KNOWN_PARTITION_TABLES } from "./esp-partition-table";

export const image = new TextEncoder().encode("reference-firmware-image-v2");
/** A stand-in C bootloader: only its image magic is checked before the digest. */
export const bootloader = new Uint8Array([0xe9, 0x03, 0x02, 0x4f, ...new TextEncoder().encode("c-bootloader")]);
/** The C partition table's `0xC00` region, as `gen_esp32part.py` encodes it. */
export const partitionTable = encodePartitionTable(KNOWN_PARTITION_TABLES.c);

/** Schema 1 `main` entries shaped like upstream ESP-Miner's NVS. */
export const settings: readonly NvsSettingEntry[] = [
  { key: "wifissid", type: "str", value: "secret-network" },
  { key: "wifipass", type: "str", value: "secret-password" },
  { key: "hostname", type: "str", value: "bitaxe" },
  { key: "pool_1", type: "str", value: '{"url":"pool.example","port":3333}' },
  { key: "prim_idx", type: "u16", value: "0" },
  { key: "asicvoltage", type: "u16", value: "1150" },
  { key: "total_uptime", type: "u64", value: "42" },
];

/** A stock Gamma 204 running from `factory`, as upstream's table boots it. */
export function snapshot(
  overrides: Partial<SimulatedBitaxeSnapshot> & { referenceFirmware?: boolean } = {},
): SimulatedBitaxeSnapshot {
  const { referenceFirmware = false, ...snapshotOverrides } = overrides;
  return {
    capabilities: {
      protocolVersion: "bwg-worker-controller/0.4",
      board: { model: "bitaxe-gamma", revision: "204", usbTransport: "web_serial" },
      firmware: { name: "stock-firmware", version: "1.0.0" },
      compatibility: {
        referenceFirmware,
        workLease: "supported",
        miningBaselineRestoration: "supported",
        settingsPreservation: referenceFirmware ? "compatible" : "upgrade_required",
      },
    },
    settingsSchemaVersion: 1,
    settingsReadable: true,
    partition: {
      scheme: "esp32-factory-ota-ab",
      appSlotBytes: 2_000_000,
      rollbackAvailable: true,
      activeSlot: "factory",
      bootable: true,
    },
    ...snapshotOverrides,
  };
}

/** Signs a schema-1 manifest with a fresh fixture Update Authority key. */
export async function firmwarePackage(
  overrides: Partial<FirmwareManifest> = {},
  packageImage: Uint8Array = image,
): Promise<{ package: FirmwarePackage; publicKey: UpdateAuthorityJwk }> {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const publicKey = {
    ...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
    kid: "update-fixture-a",
    alg: "Ed25519",
    use: "sig",
    key_ops: ["verify"],
  } as UpdateAuthorityJwk;
  const manifest: FirmwareManifest = {
    profile: "bwg-reference-firmware/0.2",
    firmwareVersion: "2.0.0",
    imageSha256: await sha256(packageImage),
    compatibleBoards: [{ model: "bitaxe-gamma", revisions: ["204"] }],
    partition: {
      scheme: "esp32-factory-ota-ab",
      minimumAppSlotBytes: 1_500_000,
      rollbackRequired: true,
    },
    settingsSchema: { minimumReadable: 1, maximumReadable: 1, target: 1 },
    firstInstall: {
      bootloaderSha256: await sha256(bootloader),
      partitionTableSha256: await sha256(partitionTable),
    },
    sourceUrl: "https://github.com/bright-builds-llc/bitaxe-esp-miner-c",
    ...overrides,
  };
  return { package: await signedPackage(manifest, keys.privateKey, packageImage), publicKey };
}

/** Signs any manifest-shaped value, so tests can present payloads the parser must refuse. */
export async function signedPackage(
  manifest: unknown,
  privateKey: CryptoKey,
  packageImage: Uint8Array = image,
): Promise<FirmwarePackage> {
  const header = encode(
    JSON.stringify({ alg: "Ed25519", typ: "bwg-firmware-manifest+jws", kid: "update-fixture-a" }),
  );
  const payload = encode(canonicalJson(manifest));
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    new TextEncoder().encode(signingInput).buffer,
  );
  return {
    manifest: manifest as FirmwareManifest,
    image: packageImage.slice(),
    bootloader: bootloader.slice(),
    partitionTable: partitionTable.slice(),
    signature: `${signingInput}.${encodeBytes(new Uint8Array(signature))}`,
  };
}

async function sha256(value: Uint8Array): Promise<string> {
  return encodeBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", value.slice().buffer)));
}

function encode(value: string): string {
  return encodeBytes(new TextEncoder().encode(value));
}

function encodeBytes(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}
