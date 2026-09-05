import { describe, expect, test } from "bun:test";

import {
  createBitaxeOnboarding,
  decryptMigrationBackup,
  type FirmwareManifest,
  type FirmwarePackage,
  type UpdateAuthorityJwk,
} from "./bitaxe-onboarding";
import {
  SimulatedBitaxeConnector,
  type SimulatedBitaxeSnapshot,
} from "./simulated-bitaxe-onboarding";
import { canonicalJson } from "./headless-values";
import {
  encryptMigrationBackup,
  MAXIMUM_MIGRATION_SETTINGS_BYTES,
} from "./bitaxe-migration-backup";

const image = new TextEncoder().encode("reference-firmware-image-v2");
const settings = new TextEncoder().encode(
  JSON.stringify({ wifi_ssid: "secret-network", wifi_password: "secret-password", pool: "pool" }),
);

describe("Bitaxe onboarding admission", () => {
  test("USB access occurs only after explicit connect and compatible firmware proceeds", async () => {
    // Arrange
    const connector = new SimulatedBitaxeConnector(snapshot({ referenceFirmware: true }), settings);
    const onboarding = createBitaxeOnboarding({ requestDevice: () => connector.requestDevice() });

    // Act
    const before = connector.requestCount();
    const inspection = await onboarding.connect();

    // Assert
    expect(before).toBe(0);
    expect(connector.requestCount()).toBe(1);
    expect(inspection.action).toBe("ready");
    expect(inspection.capabilities.board.model).toBe("bitaxe-gamma");
  });

  test("signed compatible firmware preserves settings and resumes only after redacted verification", async () => {
    // Arrange
    const connector = new SimulatedBitaxeConnector(snapshot(), settings);
    const signed = await firmwarePackage();
    const onboarding = createBitaxeOnboarding({
      requestDevice: () => connector.requestDevice(),
      trustedUpdateKeys: [signed.publicKey],
    });
    await onboarding.connect();

    // Act
    const result = await onboarding.install(signed.package);

    // Assert
    expect(result.status).toBe("ready");
    expect(result.rollback).toBe("not_required");
    expect(result.verification.categories.map((item) => item.category)).toEqual([
      "all",
      "network",
      "pool",
    ]);
    expect(JSON.stringify(result)).not.toMatch(/secret-network|secret-password|wifi_ssid|private/i);
    expect(connector.device().settingsForTest()).toEqual(settings);
    expect(connector.device().flashCount()).toBe(1);
  });

  test.each([
    ["board", { compatibleBoards: [{ model: "bitaxe-ultra", revisions: ["999"] }] }],
    ["partition", { partition: { scheme: "esp32-ota-ab", minimumAppSlotBytes: 9_999_999, rollbackRequired: true } }],
    ["schema", { settingsSchema: { minimumReadable: 5, maximumReadable: 6, target: 6 } }],
  ] as const)("rejects incompatible %s before flashing", async (_name, overrides) => {
    // Arrange
    const connector = new SimulatedBitaxeConnector(snapshot(), settings);
    const signed = await firmwarePackage(overrides);
    const onboarding = createBitaxeOnboarding({
      requestDevice: () => connector.requestDevice(),
      trustedUpdateKeys: [signed.publicKey],
    });
    await onboarding.connect();

    // Act
    const install = onboarding.install(signed.package);

    // Assert
    await expect(install).rejects.toThrow("firmware package is not safely compatible");
    expect(connector.device().flashCount()).toBe(0);
  });

  test.each([
    ["unsupported preservation", snapshot({
      capabilities: {
        ...snapshot().capabilities,
        compatibility: {
          ...snapshot().capabilities.compatibility,
          settingsPreservation: "unsupported",
        },
      },
    })],
    ["unbootable current partition", snapshot({
      partition: { ...snapshot().partition, bootable: false },
    })],
  ] as const)("rejects %s before reading settings or flashing", async (_name, unsafeSnapshot) => {
    // Arrange
    const connector = new SimulatedBitaxeConnector(unsafeSnapshot, settings);
    const signed = await firmwarePackage();
    const onboarding = createBitaxeOnboarding({
      requestDevice: () => connector.requestDevice(),
      trustedUpdateKeys: [signed.publicKey],
    });
    await onboarding.connect();

    // Act
    const install = onboarding.install(signed.package);

    // Assert
    await expect(install).rejects.toThrow("firmware package is not safely compatible");
    expect(connector.device().maximumPlaintextBytesObserved()).toBe(0);
    expect(connector.device().flashCount()).toBe(0);
  });

  test("rejects a tampered image digest before flashing", async () => {
    // Arrange
    const connector = new SimulatedBitaxeConnector(snapshot(), settings);
    const signed = await firmwarePackage();
    signed.package.image[0] = (signed.package.image[0] ?? 0) ^ 1;
    const onboarding = createBitaxeOnboarding({
      requestDevice: () => connector.requestDevice(),
      trustedUpdateKeys: [signed.publicKey],
    });
    await onboarding.connect();

    // Act
    const install = onboarding.install(signed.package);

    // Assert
    await expect(install).rejects.toThrow("firmware image digest is invalid");
    expect(connector.device().flashCount()).toBe(0);
  });

  test("rejects a manifest changed after Update Authority signing", async () => {
    // Arrange
    const connector = new SimulatedBitaxeConnector(snapshot(), settings);
    const signed = await firmwarePackage();
    signed.package.manifest.firmwareVersion = "3.0.0";
    const onboarding = createBitaxeOnboarding({
      requestDevice: () => connector.requestDevice(),
      trustedUpdateKeys: [signed.publicKey],
    });
    await onboarding.connect();

    // Act
    const install = onboarding.install(signed.package);

    // Assert
    await expect(install).rejects.toThrow("firmware manifest signature is invalid");
    expect(connector.device().flashCount()).toBe(0);
  });

  test("rejects an oversized compact signature before decoding or flashing", async () => {
    // Arrange
    const connector = new SimulatedBitaxeConnector(snapshot(), settings);
    const signed = await firmwarePackage();
    signed.package.signature = `${"a".repeat(513)}.a.${"a".repeat(86)}`;
    const onboarding = createBitaxeOnboarding({
      requestDevice: () => connector.requestDevice(),
      trustedUpdateKeys: [signed.publicKey],
    });
    await onboarding.connect();

    // Act
    const install = onboarding.install(signed.package);

    // Assert
    await expect(install).rejects.toThrow("firmware manifest signature is invalid");
    expect(connector.device().flashCount()).toBe(0);
  });

  test("rejects unbounded manifest collections before WebCrypto or flashing", async () => {
    // Arrange
    const connector = new SimulatedBitaxeConnector(snapshot(), settings);
    const compatibleBoards = Array.from({ length: 33 }, (_, index) => ({
      model: `bitaxe-${index}`,
      revisions: ["204"],
    }));
    const signed = await firmwarePackage({ compatibleBoards });
    const onboarding = createBitaxeOnboarding({
      requestDevice: () => connector.requestDevice(),
      trustedUpdateKeys: [signed.publicKey],
    });
    await onboarding.connect();

    // Act
    const install = onboarding.install(signed.package);

    // Assert
    await expect(install).rejects.toThrow("firmware manifest is invalid");
    expect(connector.device().flashCount()).toBe(0);
  });

  test.each([
    ["credentials", "https://user:password@example.com/reference-firmware"],
    ["query parameters", "https://example.com/reference-firmware?token=secret"],
    ["fragments", "https://example.com/reference-firmware#private"],
  ] as const)("rejects source URL %s before flashing", async (_name, sourceUrl) => {
    // Arrange
    const connector = new SimulatedBitaxeConnector(snapshot(), settings);
    const signed = await firmwarePackage({ sourceUrl });
    const onboarding = createBitaxeOnboarding({
      requestDevice: () => connector.requestDevice(),
      trustedUpdateKeys: [signed.publicKey],
    });
    await onboarding.connect();

    // Act
    const install = onboarding.install(signed.package);

    // Assert
    await expect(install).rejects.toThrow("firmware manifest is invalid");
    expect(connector.device().flashCount()).toBe(0);
  });

  test("snapshots caller-owned firmware bytes before asynchronous verification", async () => {
    // Arrange
    const connector = new SimulatedBitaxeConnector(snapshot(), settings);
    const signed = await firmwarePackage();
    const admittedImage = signed.package.image.slice();
    const onboarding = createBitaxeOnboarding({
      requestDevice: () => connector.requestDevice(),
      trustedUpdateKeys: [signed.publicKey],
    });
    await onboarding.connect();

    // Act
    const install = onboarding.install(signed.package);
    signed.package.image.fill(0);
    signed.package.manifest.firmwareVersion = "9.9.9";
    const result = await install;

    // Assert
    expect(result.firmwareVersion).toBe("2.0.0");
    expect(connector.device().flashedImageForTest()).toEqual(admittedImage);
  });

  test("allows only one install flight per connected device", async () => {
    // Arrange
    const connector = new SimulatedBitaxeConnector(snapshot(), settings);
    const signed = await firmwarePackage();
    const onboarding = createBitaxeOnboarding({
      requestDevice: () => connector.requestDevice(),
      trustedUpdateKeys: [signed.publicKey],
    });
    await onboarding.connect();

    // Act
    const first = onboarding.install(signed.package);
    const concurrent = onboarding.install(signed.package);
    const concurrentCheck = expect(concurrent).rejects.toThrow("install is already active");
    await Promise.all([first, concurrentCheck]);

    // Assert
    await expect(onboarding.install(signed.package)).rejects.toThrow("install is already active");
    expect(connector.device().flashCount()).toBe(1);
  });

  test("rejects device snapshots containing undeclared secret fields", async () => {
    // Arrange
    const connector = new SimulatedBitaxeConnector(snapshot(), settings);
    const device = connector.device();
    const onboarding = createBitaxeOnboarding({
      requestDevice: async () => new Proxy(device, {
        get(target, property, receiver) {
          if (property === "inspect") {
            return async () => ({ ...(await target.inspect()), wifiPassword: "must-not-leak" });
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    });

    // Act
    const connect = onboarding.connect();

    // Assert
    await expect(connect).rejects.toThrow("snapshot is invalid");
  });
});

describe("Bitaxe migration backup and recovery", () => {
  test("optional credential backup is encrypted and downloaded locally", async () => {
    // Arrange
    const connector = new SimulatedBitaxeConnector(snapshot(), settings);
    const signed = await firmwarePackage();
    const downloads: Uint8Array[] = [];
    const onboarding = createBitaxeOnboarding({
      requestDevice: () => connector.requestDevice(),
      trustedUpdateKeys: [signed.publicKey],
      downloadMigrationBackup: async (backup) => {
        downloads.push(backup.slice());
      },
    });
    await onboarding.connect();

    // Act
    await onboarding.install(signed.package, { maybeBackupPassphrase: "correct horse battery" });

    // Assert
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.byteLength).toBeGreaterThan(settings.byteLength);
    expect(new TextDecoder().decode(downloads[0])).not.toContain("secret-password");
    expect(
      await decryptMigrationBackup(downloads[0] ?? new Uint8Array(), "correct horse battery"),
    ).toEqual(settings);
    expect(connector.device().maximumPlaintextBytesObserved()).toBe(settings.byteLength);
  });

  test("wipes the encrypted transfer buffer when local download fails", async () => {
    // Arrange
    const connector = new SimulatedBitaxeConnector(snapshot(), settings);
    const signed = await firmwarePackage();
    let maybeTransferBuffer: Uint8Array | undefined;
    const onboarding = createBitaxeOnboarding({
      requestDevice: () => connector.requestDevice(),
      trustedUpdateKeys: [signed.publicKey],
      downloadMigrationBackup: async (backup) => {
        maybeTransferBuffer = backup;
        throw new Error("simulated local download rejection");
      },
    });
    await onboarding.connect();

    // Act
    const install = onboarding.install(signed.package, {
      maybeBackupPassphrase: "correct horse battery",
    });

    // Assert
    await expect(install).rejects.toThrow("simulated local download rejection");
    expect(maybeTransferBuffer?.every((byte) => byte === 0)).toBe(true);
    expect(connector.device().flashCount()).toBe(0);
  });

  test("backup encryption and decryption reject oversized inputs before cryptography", async () => {
    // Arrange
    const oversizedSettings = new Uint8Array(MAXIMUM_MIGRATION_SETTINGS_BYTES + 1);
    const oversizedEnvelope = new Uint8Array(100_001);

    // Act
    const encrypt = encryptMigrationBackup(oversizedSettings, "correct horse battery");
    const decrypt = decryptMigrationBackup(oversizedEnvelope, "correct horse battery");

    // Assert
    await expect(encrypt).rejects.toThrow("settings size is invalid");
    await expect(decrypt).rejects.toThrow("Migration Backup is invalid");
  });

  test("oversized settings stop before backup or flashing", async () => {
    // Arrange
    const oversized = new Uint8Array(65_537);
    const connector = new SimulatedBitaxeConnector(snapshot(), oversized);
    const signed = await firmwarePackage();
    const onboarding = createBitaxeOnboarding({
      requestDevice: () => connector.requestDevice(),
      trustedUpdateKeys: [signed.publicKey],
    });
    await onboarding.connect();

    // Act
    const install = onboarding.install(signed.package);

    // Assert
    await expect(install).rejects.toThrow("settings exceed the bounded migration window");
    expect(connector.device().flashCount()).toBe(0);
  });

  test("unreadable settings stop before flashing", async () => {
    // Arrange
    const connector = new SimulatedBitaxeConnector(
      snapshot({ settingsReadable: false }),
      settings,
    );
    const signed = await firmwarePackage();
    const onboarding = createBitaxeOnboarding({
      requestDevice: () => connector.requestDevice(),
      trustedUpdateKeys: [signed.publicKey],
    });
    await onboarding.connect();

    // Act
    const install = onboarding.install(signed.package);

    // Assert
    await expect(install).rejects.toThrow("firmware package is not safely compatible");
    expect(connector.device().flashCount()).toBe(0);
  });

  test("failed post-reboot verification rolls back to a recoverable image", async () => {
    // Arrange
    const connector = new SimulatedBitaxeConnector(snapshot(), settings, {
      failFirstVerification: true,
    });
    const signed = await firmwarePackage();
    const onboarding = createBitaxeOnboarding({
      requestDevice: () => connector.requestDevice(),
      trustedUpdateKeys: [signed.publicKey],
    });
    await onboarding.connect();

    // Act
    const result = await onboarding.install(signed.package);

    // Assert
    expect(result).toMatchObject({ status: "rolled_back", rollback: "confirmed" });
    expect(connector.device().rollbackCount()).toBe(1);
    expect(connector.device().settingsForTest()).toEqual(settings);
  });

  test("interrupted flashing rolls back to a recoverable image", async () => {
    // Arrange
    const connector = new SimulatedBitaxeConnector(snapshot(), settings, {
      failFlashAfterWrite: true,
    });
    const signed = await firmwarePackage();
    const onboarding = createBitaxeOnboarding({
      requestDevice: () => connector.requestDevice(),
      trustedUpdateKeys: [signed.publicKey],
    });
    await onboarding.connect();

    // Act
    const result = await onboarding.install(signed.package);

    // Assert
    expect(result).toMatchObject({ status: "rolled_back", rollback: "confirmed" });
    expect(connector.device().rollbackCount()).toBe(1);
    expect(connector.device().settingsForTest()).toEqual(settings);
  });

  test("rejects undeclared post-reboot proof fields and rolls back", async () => {
    // Arrange
    const connector = new SimulatedBitaxeConnector(snapshot(), settings);
    const signed = await firmwarePackage();
    const device = connector.device();
    const onboarding = createBitaxeOnboarding({
      requestDevice: async () => new Proxy(device, {
        get(target, property, receiver) {
          if (property === "verifyRedactedSettings") {
            return async () => ({
              ...(await target.verifyRedactedSettings()),
              wifiPassword: "must-not-leak",
            });
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
      trustedUpdateKeys: [signed.publicKey],
    });
    await onboarding.connect();

    // Act
    const install = onboarding.install(signed.package);

    // Assert
    await expect(install).rejects.toThrow("installation and recovery both failed");
    expect(connector.device().rollbackCount()).toBe(1);
  });
});

function snapshot(
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
    settingsSchemaVersion: 2,
    settingsReadable: true,
    partition: {
      scheme: "esp32-ota-ab",
      appSlotBytes: 2_000_000,
      rollbackAvailable: true,
      activeSlot: "ota_0",
      bootable: true,
    },
    ...snapshotOverrides,
  };
}

async function firmwarePackage(
  overrides: Partial<FirmwareManifest> = {},
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
    profile: "bwg-reference-firmware/0.1",
    firmwareVersion: "2.0.0",
    imageSha256: await sha256(image),
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
  const header = encode(JSON.stringify({ alg: "Ed25519", typ: "bwg-firmware-manifest+jws", kid: publicKey.kid }));
  const payload = encode(canonicalJson(manifest));
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "Ed25519",
    keys.privateKey,
    new TextEncoder().encode(signingInput).buffer,
  );
  return {
    package: {
      manifest,
      image: image.slice(),
      signature: `${signingInput}.${encodeBytes(new Uint8Array(signature))}`,
    },
    publicKey,
  };
}

async function sha256(value: Uint8Array): Promise<string> {
  return encodeBytes(
    new Uint8Array(await crypto.subtle.digest("SHA-256", value.slice().buffer)),
  );
}

function encode(value: string): string {
  return encodeBytes(new TextEncoder().encode(value));
}

function encodeBytes(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}
