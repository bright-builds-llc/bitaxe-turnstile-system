import { createBitaxeOnboarding } from "../../dist/bitaxe-onboarding/bitaxe-onboarding-entry.js";
import { SimulatedBitaxeConnector } from "../../dist/bitaxe-onboarding-simulator/bitaxe-onboarding-simulator-entry.js";

export async function bitaxeOnboardingFixture(manifestOverrides = {}) {
  const settings = [
    { key: "wifissid", type: "str", value: "secret-network" },
    { key: "wifipass", type: "str", value: "secret-password" },
    { key: "pool_1", type: "str", value: '{"url":"pool.example","port":3333}' },
    { key: "prim_idx", type: "u16", value: "0" },
  ];
  const connector = new SimulatedBitaxeConnector(bitaxeSnapshot(), settings);
  const signed = await signedFirmwarePackage(manifestOverrides);
  return {
    connector,
    settings,
    firmwarePackage: signed.firmwarePackage,
    onboarding: createBitaxeOnboarding({
      requestDevice: () => connector.requestDevice(),
      trustedUpdateKeys: [signed.publicKey],
    }),
  };
}

function bitaxeSnapshot() {
  return {
    capabilities: {
      protocolVersion: "bwg-worker-controller/0.4",
      board: { model: "bitaxe-gamma", revision: "204", usbTransport: "web_serial" },
      firmware: { name: "stock-firmware", version: "1.0.0" },
      compatibility: {
        referenceFirmware: false,
        workLease: "supported",
        miningBaselineRestoration: "supported",
        settingsPreservation: "upgrade_required",
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
  };
}

/** The C image's table as `gen_esp32part.py` built it at bitaxe-esp-miner-c `51e5af9`, before its `0xFF` fill. */
const C_PARTITION_TABLE_HEX =
  "aa50010200900000006000006e76730000000000000000000000000000000000" +
  "aa50010100f00000001000007068795f696e6974000000000000000000000000" +
  "aa5000000000010000004000666163746f727900000000000000000000000000" +
  "aa50018200004100000030007777770000000000000000000000000000000000" +
  "aa50001000007100000040006f74615f30000000000000000000000000000000" +
  "aa5000110000b100000040006f74615f31000000000000000000000000000000" +
  "aa5001000000f100002000006f74616461746100000000000000000000000000" +
  "aa5001030020f10000e00e00636f726564756d70000000000000000000000000" +
  "ebebffffffffffffffffffffffffffff3263d40fec2a495265671ec0d6d91d45";

function cPartitionTable() {
  const table = new Uint8Array(0xc00).fill(0xff);
  table.set(C_PARTITION_TABLE_HEX.match(/../gu).map((pair) => Number.parseInt(pair, 16)));
  return table;
}

async function signedFirmwarePackage(overrides = {}) {
  const image = new TextEncoder().encode("reference-firmware-browser-image");
  const bootloader = new Uint8Array([0xe9, ...new TextEncoder().encode("browser-c-bootloader")]);
  const partitionTable = cPartitionTable();
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const publicKey = {
    ...await crypto.subtle.exportKey("jwk", keys.publicKey),
    kid: "browser-update-authority",
    alg: "Ed25519",
    use: "sig",
    key_ops: ["verify"],
  };
  const manifest = {
    profile: "bwg-reference-firmware/0.2",
    firmwareVersion: "2.0.0",
    imageSha256: await digestBase64Url(image),
    compatibleBoards: [{ model: "bitaxe-gamma", revisions: ["204"] }],
    partition: {
      scheme: "esp32-factory-ota-ab",
      minimumAppSlotBytes: 1_500_000,
      rollbackRequired: true,
    },
    settingsSchema: { minimumReadable: 1, maximumReadable: 1, target: 1 },
    firstInstall: {
      bootloaderSha256: await digestBase64Url(bootloader),
      partitionTableSha256: await digestBase64Url(partitionTable),
    },
    sourceUrl: "https://github.com/bright-builds-llc/bitaxe-esp-miner-c",
    ...overrides,
  };
  const header = encodeBase64Url(new TextEncoder().encode(JSON.stringify({
    alg: "Ed25519",
    typ: "bwg-firmware-manifest+jws",
    kid: publicKey.kid,
  })));
  const payload = encodeBase64Url(new TextEncoder().encode(canonicalJson(manifest)));
  const signingInput = `${header}.${payload}`;
  const signature = new Uint8Array(await crypto.subtle.sign(
    "Ed25519",
    keys.privateKey,
    new TextEncoder().encode(signingInput),
  ));
  return {
    publicKey,
    firmwarePackage: {
      manifest,
      image,
      bootloader,
      partitionTable,
      signature: `${signingInput}.${encodeBase64Url(signature)}`,
    },
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function digestBase64Url(value) {
  return encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", value)));
}

function encodeBase64Url(value) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
