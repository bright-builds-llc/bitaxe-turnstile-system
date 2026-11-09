import { describe, expect, test } from "bun:test";

import {
  createBitaxeOnboarding,
  type BitaxeOnboardingDevice,
  type MigrationSettings,
  type RedactedSettingsVerification,
} from "./bitaxe-onboarding";
import {
  SimulatedBitaxeConnector,
  type SimulatedBitaxeOptions,
  type SimulatedBitaxeSnapshot,
} from "./simulated-bitaxe-onboarding";
import { firmwarePackage, settings, snapshot } from "./bitaxe-onboarding-test-fixtures";

const passphrase = "correct horse battery";

async function onboardingFor(
  options: {
    snapshot?: SimulatedBitaxeSnapshot;
    device?: SimulatedBitaxeOptions;
    wrap?: (device: BitaxeOnboardingDevice) => BitaxeOnboardingDevice;
  } = {},
) {
  const connector = new SimulatedBitaxeConnector(
    options.snapshot ?? snapshot(),
    settings,
    options.device,
  );
  const signed = await firmwarePackage();
  const downloads: Uint8Array[] = [];
  const onboarding = createBitaxeOnboarding({
    requestDevice: async () => (options.wrap ?? ((device) => device))(connector.device()),
    trustedUpdateKeys: [signed.publicKey],
    downloadMigrationBackup: async (backup) => {
      downloads.push(backup.slice());
    },
  });
  return { connector, device: connector.device(), onboarding, firmware: signed.package, downloads };
}

/** Wraps a device so a test can watch or change one method. */
function wrapped(
  device: BitaxeOnboardingDevice,
  overrides: Partial<BitaxeOnboardingDevice>,
): BitaxeOnboardingDevice {
  return {
    inspect: () => device.inspect(),
    readMigrationSettings: (maximumBytes) => device.readMigrationSettings(maximumBytes),
    flash: (input) => device.flash(input),
    reboot: () => device.reboot(),
    verifyRedactedSettings: (nonce) => device.verifyRedactedSettings(nonce),
    rollback: (input) => device.rollback(input),
    ...overrides,
  };
}

/** Captures the raw partition onboarding keeps, so a test can see whether it was wiped. */
function capturingCopy(captured: Uint8Array[]) {
  return (device: BitaxeOnboardingDevice) =>
    wrapped(device, {
      readMigrationSettings: async (maximumBytes): Promise<MigrationSettings> => {
        const migration = await device.readMigrationSettings(maximumBytes);
        captured.push(migration.nvsPartition);
        return migration;
      },
    });
}

const wiped = (buffer: Uint8Array | undefined) => buffer?.every((byte) => byte === 0) === true;

describe("Bitaxe onboarding inspection", () => {
  test("recommends the Migration Backup for a first install from stock", async () => {
    // Arrange
    const { onboarding } = await onboardingFor();

    // Act
    const inspection = await onboarding.connect();

    // Assert
    expect(inspection.migrationBackup).toBe("recommended");
  });

  test("keeps the Migration Backup optional between reference images", async () => {
    // Arrange
    const { onboarding } = await onboardingFor({
      snapshot: snapshot({ referenceFirmware: true }),
    });

    // Act
    const inspection = await onboarding.connect();

    // Assert
    expect(inspection.migrationBackup).toBe("optional");
  });
});

describe("Bitaxe install slots and nonce", () => {
  test.each([
    ["factory", "ota_0"],
    ["ota_1", "ota_0"],
    ["ota_0", "ota_1"],
  ] as const)("installs from %s into %s", async (activeSlot, expectedSlot) => {
    // Arrange
    const { onboarding, device, firmware } = await onboardingFor({
      snapshot: snapshot({ partition: { ...snapshot().partition, activeSlot } }),
    });
    await onboarding.connect();

    // Act
    const result = await onboarding.install(firmware);

    // Assert
    expect(result.verification.activeSlot).toBe(expectedSlot);
    expect((await device.inspect()).partition.activeSlot).toBe(expectedSlot);
  });

  test("verifies under a fresh 32-byte nonce for each onboarding", async () => {
    // Arrange
    const first = await onboardingFor();
    const second = await onboardingFor();
    await first.onboarding.connect();
    await second.onboarding.connect();

    // Act
    await first.onboarding.install(first.firmware);
    await second.onboarding.install(second.firmware);

    // Assert
    const [firstNonce] = first.device.verificationNoncesForTest();
    const [secondNonce] = second.device.verificationNoncesForTest();
    expect(Buffer.from(firstNonce ?? "", "base64url")).toHaveLength(32);
    expect(firstNonce).not.toBe(secondNonce);
  });

  test("keeps the nonce out of the returned evidence", async () => {
    // Arrange
    const { onboarding, firmware } = await onboardingFor();
    await onboarding.connect();

    // Act
    const result = await onboarding.install(firmware);

    // Assert
    expect(Object.keys(result.verification)).not.toContain("nonce");
  });

  test("rolls back when the new image's settings HMACs differ", async () => {
    // Arrange
    const changed = settings.filter((entry) => entry.key !== "wifipass");
    const { onboarding, device, firmware } = await onboardingFor({
      device: { maybeSettingsAfterFlash: changed },
    });
    await onboarding.connect();

    // Act
    const result = await onboarding.install(firmware);

    // Assert
    expect(result.status).toBe("rolled_back");
    expect(device.settingsForTest()).toEqual(settings);
  });

  test.each([
    [
      "a reply under another nonce",
      (reply: RedactedSettingsVerification) => ({ ...reply, nonce: "A".repeat(43) }),
    ],
    [
      "plain SHA-256 digests",
      (reply: RedactedSettingsVerification) => ({
        ...reply,
        categories: reply.categories.map(({ category, hmacSha256 }) => ({
          category,
          digestSha256: hmacSha256,
        })),
      }),
    ],
  ] as const)("rolls back after %s", async (_name, tamper) => {
    // Arrange
    let tampered = false;
    const { onboarding, firmware } = await onboardingFor({
      wrap: (device) =>
        wrapped(device, {
          verifyRedactedSettings: async (nonce) => {
            const reply = await device.verifyRedactedSettings(nonce);
            if (tampered) return reply;
            tampered = true;
            return tamper(reply) as RedactedSettingsVerification;
          },
        }),
    });
    await onboarding.connect();

    // Act
    const result = await onboarding.install(firmware);

    // Assert
    expect(result.status).toBe("rolled_back");
  });
});

describe("Bitaxe rollback copy", () => {
  test("is available after a ready install", async () => {
    // Arrange
    const { onboarding, firmware } = await onboardingFor();
    await onboarding.connect();

    // Act
    await onboarding.install(firmware);

    // Assert
    expect(onboarding.rollbackState()).toBe("available");
  });

  test("is unavailable before any install", async () => {
    // Arrange
    const { onboarding } = await onboardingFor();

    // Act
    await onboarding.connect();

    // Assert
    expect(onboarding.rollbackState()).toBe("unavailable");
  });

  test("restores the previous slot and settings from memory after mark-valid", async () => {
    // Arrange
    const { onboarding, device, firmware } = await onboardingFor();
    await onboarding.connect();
    await onboarding.install(firmware);
    device.replaceSettingsForTest([]);

    // Act
    const result = await onboarding.rollBack();

    // Assert
    expect(result).toMatchObject({ status: "rolled_back", rollback: "confirmed" });
    expect(result.verification.activeSlot).toBe("factory");
    expect(device.settingsForTest()).toEqual(settings);
  });

  test("is wiped when the user completes onboarding", async () => {
    // Arrange
    const captured: Uint8Array[] = [];
    const { onboarding, firmware } = await onboardingFor({ wrap: capturingCopy(captured) });
    await onboarding.connect();
    await onboarding.install(firmware);

    // Act
    onboarding.complete();

    // Assert
    expect(wiped(captured[0])).toBe(true);
    expect(onboarding.rollbackState()).toBe("unavailable");
  });

  test("is wiped when installation fails before flashing", async () => {
    // Arrange
    const captured: Uint8Array[] = [];
    const { onboarding, firmware } = await onboardingFor({ wrap: capturingCopy(captured) });
    await onboarding.connect();

    // Act
    const install = onboarding.install(firmware, { maybeBackupPassphrase: "short" });

    // Assert
    await expect(install).rejects.toThrow("passphrase is invalid");
    expect(wiped(captured[0])).toBe(true);
  });

  test("is wiped after an automatic rollback", async () => {
    // Arrange
    const captured: Uint8Array[] = [];
    const { onboarding, firmware } = await onboardingFor({
      wrap: capturingCopy(captured),
      device: { failFirstVerification: true },
    });
    await onboarding.connect();

    // Act
    await onboarding.install(firmware);

    // Assert
    expect(wiped(captured[0])).toBe(true);
    expect(onboarding.rollbackState()).toBe("unavailable");
  });

  test("is wiped after a user rollback", async () => {
    // Arrange
    const captured: Uint8Array[] = [];
    const { onboarding, firmware } = await onboardingFor({ wrap: capturingCopy(captured) });
    await onboarding.connect();
    await onboarding.install(firmware);

    // Act
    await onboarding.rollBack();

    // Assert
    expect(wiped(captured[0])).toBe(true);
    expect(onboarding.rollbackState()).toBe("unavailable");
  });
});

describe("Bitaxe rollback from the Migration Backup download", () => {
  test("needs the download once onboarding is complete", async () => {
    // Arrange
    const { onboarding, firmware } = await onboardingFor();
    await onboarding.connect();
    await onboarding.install(firmware, { maybeBackupPassphrase: passphrase });

    // Act
    onboarding.complete();

    // Assert
    expect(onboarding.rollbackState()).toBe("backup_required");
  });

  test("refuses to roll back without the download", async () => {
    // Arrange
    const { onboarding, device, firmware } = await onboardingFor();
    await onboarding.connect();
    await onboarding.install(firmware, { maybeBackupPassphrase: passphrase });
    onboarding.complete();

    // Act
    const rollBack = onboarding.rollBack();

    // Assert
    await expect(rollBack).rejects.toThrow("needs the Migration Backup download");
    expect(device.rollbackCount()).toBe(0);
  });

  test("restores settings from the supplied download", async () => {
    // Arrange
    const { onboarding, device, firmware, downloads } = await onboardingFor();
    await onboarding.connect();
    await onboarding.install(firmware, { maybeBackupPassphrase: passphrase });
    onboarding.complete();
    device.replaceSettingsForTest([]);

    // Act
    const result = await onboarding.rollBack({
      maybeMigrationBackup: { encryptedBackup: downloads[0] ?? new Uint8Array(), passphrase },
    });

    // Assert
    expect(result.status).toBe("rolled_back");
    expect(device.settingsForTest()).toEqual(settings);
  });

  test("refuses a download of other settings after restoring it", async () => {
    // Arrange
    const other = await onboardingFor();
    await other.onboarding.connect();
    other.device.replaceSettingsForTest(settings.slice(1));
    await other.onboarding.install(other.firmware, { maybeBackupPassphrase: passphrase });
    const { onboarding, firmware } = await onboardingFor();
    await onboarding.connect();
    await onboarding.install(firmware, { maybeBackupPassphrase: passphrase });
    onboarding.complete();

    // Act
    const rollBack = onboarding.rollBack({
      maybeMigrationBackup: { encryptedBackup: other.downloads[0] ?? new Uint8Array(), passphrase },
    });

    // Assert
    await expect(rollBack).rejects.toThrow("post-reboot recovery could not be established");
  });
});
