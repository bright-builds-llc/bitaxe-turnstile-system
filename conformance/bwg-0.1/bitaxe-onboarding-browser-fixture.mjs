import { createBitaxeOnboarding } from "../../dist/bitaxe-onboarding/bitaxe-onboarding-entry.js";
import { SimulatedBitaxeConnector } from "../../dist/bitaxe-onboarding-simulator/bitaxe-onboarding-simulator-entry.js";

export async function bitaxeOnboardingFixture(manifestOverrides = {}) {
  const settings = new TextEncoder().encode(JSON.stringify({
    wifi_ssid: "secret-network",
    wifi_password: "secret-password",
    pool: "pool.example",
  }));
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
    settingsSchemaVersion: 2,
    settingsReadable: true,
    partition: {
      scheme: "esp32-ota-ab",
      appSlotBytes: 2_000_000,
      rollbackAvailable: true,
      activeSlot: "ota_0",
      bootable: true,
    },
  };
}

async function signedFirmwarePackage(overrides = {}) {
  const image = new TextEncoder().encode("reference-firmware-browser-image");
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const publicKey = {
    ...await crypto.subtle.exportKey("jwk", keys.publicKey),
    kid: "browser-update-authority",
    alg: "Ed25519",
    use: "sig",
    key_ops: ["verify"],
  };
  const manifest = {
    profile: "bwg-reference-firmware/0.1",
    firmwareVersion: "2.0.0",
    imageSha256: await digestBase64Url(image),
    compatibleBoards: [{ model: "bitaxe-gamma", revisions: ["204"] }],
    partition: {
      scheme: "esp32-ota-ab",
      minimumAppSlotBytes: 1_500_000,
      rollbackRequired: true,
    },
    settingsSchema: { minimumReadable: 1, maximumReadable: 3, target: 3 },
    sourceUrl: "https://github.com/bright-builds-llc/bitaxe-esp-miner",
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
