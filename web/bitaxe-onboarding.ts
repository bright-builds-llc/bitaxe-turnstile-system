import { canonicalJson } from "./headless-values";
import type { WorkerControllerCapabilities } from "./worker-controller-semantics";
import {
  parseDeviceSnapshot,
  parseVerification,
} from "./bitaxe-onboarding-boundaries";
import {
  admitFirmwarePackage,
  type FirmwareManifest,
  type FirmwarePackage,
  type UpdateAuthorityJwk,
} from "./bitaxe-firmware-package";
import { sha256Base64UrlBytes } from "./crypto-bytes";
import {
  encryptMigrationBackup,
  MAXIMUM_MIGRATION_SETTINGS_BYTES,
} from "./bitaxe-migration-backup";
export {
  decryptMigrationBackup,
  MAXIMUM_MIGRATION_SETTINGS_BYTES,
} from "./bitaxe-migration-backup";

export {
  MAXIMUM_FIRMWARE_IMAGE_BYTES,
  type FirmwareManifest,
  type FirmwarePackage,
  type UpdateAuthorityJwk,
} from "./bitaxe-firmware-package";

/** Non-secret local facts needed to decide whether flashing can be safe. */
export type BitaxeDeviceSnapshot = {
  capabilities: WorkerControllerCapabilities;
  settingsSchemaVersion: number;
  settingsReadable: boolean;
  partition: {
    scheme: "esp32-ota-ab";
    appSlotBytes: number;
    rollbackAvailable: boolean;
    activeSlot: "ota_0" | "ota_1";
    bootable: boolean;
  };
};

/** Redacted post-reboot proof that admitted setting categories were retained. */
export type RedactedSettingsVerification = {
  preservationConfirmed: boolean;
  runningFirmwareVersion: string;
  settingsSchemaVersion: number;
  activeSlot: "ota_0" | "ota_1";
  bootable: boolean;
  rollbackState: "available" | "confirmed";
  categories: readonly {
    category: "all" | "network" | "pool";
    digestSha256: string;
  }[];
};
type RedactedSettingsCategories = RedactedSettingsVerification["categories"];

/** USB device operations required by the browser onboarding state machine. */
export interface BitaxeOnboardingDevice {
  /** Reads a strict, non-secret snapshot without changing device state. */
  inspect(): Promise<BitaxeDeviceSnapshot>;
  /** Returns a caller-owned settings copy no larger than `maximumBytes`. */
  readMigrationSettings(maximumBytes: number): Promise<Uint8Array>;
  /** Copies all input buffers before resolving after the irreversible slot write completes. */
  flash(input: {
    image: Uint8Array;
    firmwareVersion: string;
    targetSettingsSchema: number;
    preservedSettings: Uint8Array;
  }): Promise<void>;
  /** Reboots into the selected slot and resolves only after device continuity is restored. */
  reboot(): Promise<void>;
  /** Returns strict redacted proof for the currently running firmware and settings. */
  verifyRedactedSettings(): Promise<RedactedSettingsVerification>;
  /** Restores the pre-flash slot and settings, rejecting unless recovery can be attempted. */
  rollback(): Promise<void>;
}

/** Strict non-secret inspection returned after the user selects a local device. */
export type BitaxeOnboardingInspection = {
  action: "ready" | "firmware_required";
  capabilities: WorkerControllerCapabilities;
  settingsSchemaVersion: number;
};

/** Terminal, redacted evidence that installation or verified rollback completed safely. */
export type BitaxeOnboardingResult = {
  status: "ready" | "rolled_back";
  rollback: "not_required" | "confirmed";
  firmwareVersion: string;
  verification: RedactedSettingsVerification;
};

/** Single-device, single-install onboarding lifecycle. */
export type BitaxeOnboarding = {
  /** Explicit user-action seam that alone may request local USB device access. */
  connect(): Promise<BitaxeOnboardingInspection>;
  /** Verifies, preserves, flashes, reboots, and redacted-verifies one admitted package. */
  install(
    firmwarePackage: FirmwarePackage,
    options?: { maybeBackupPassphrase?: string },
  ): Promise<BitaxeOnboardingResult>;
};

/** Creates accountless browser onboarding without network or mobile/account dependencies. */
export function createBitaxeOnboarding(input: {
  requestDevice: () => Promise<BitaxeOnboardingDevice>;
  trustedUpdateKeys?: readonly UpdateAuthorityJwk[];
  /** Persists a borrowed encrypted buffer before return; onboarding wipes it on every exit. */
  downloadMigrationBackup?: (encryptedBackup: Uint8Array) => Promise<void>;
}): BitaxeOnboarding {
  let maybeDevice: BitaxeOnboardingDevice | undefined;
  let maybeSnapshot: BitaxeDeviceSnapshot | undefined;
  let state: "disconnected" | "connecting" | "connected" | "installing" | "completed" =
    "disconnected";
  return {
    async connect() {
      if (state !== "disconnected") {
        throw new Error("Bitaxe onboarding connection is already active");
      }
      state = "connecting";
      try {
        const device = await input.requestDevice();
        const snapshot = parseDeviceSnapshot(await device.inspect());
        maybeDevice = device;
        maybeSnapshot = snapshot;
        state = "connected";
        return {
          action:
            snapshot.capabilities.compatibility.referenceFirmware &&
            snapshot.capabilities.compatibility.settingsPreservation === "compatible"
              ? "ready"
              : "firmware_required",
          capabilities: structuredClone(snapshot.capabilities),
          settingsSchemaVersion: snapshot.settingsSchemaVersion,
        };
      } finally {
        if (state === "connecting") state = "disconnected";
      }
    },
    async install(firmwarePackage, options = {}) {
      if (state !== "connected") {
        throw new Error(
          state === "installing" || state === "completed"
            ? "Bitaxe onboarding install is already active"
            : "Bitaxe USB connection is required",
        );
      }
      const device = maybeDevice;
      const snapshot = maybeSnapshot;
      if (!device || !snapshot) throw new Error("Bitaxe USB connection is required");
      state = "installing";
      let completed = false;
      let irreversibleAttempted = false;
      try {
        const trustedKeys = input.trustedUpdateKeys ?? [];
        const admitted = await admitFirmwarePackage(firmwarePackage, trustedKeys, snapshot);
        if (!snapshot.settingsReadable) {
          throw new Error("firmware package is not safely compatible");
        }
        const preservedSettings = await device.readMigrationSettings(
          MAXIMUM_MIGRATION_SETTINGS_BYTES,
        );
        if (preservedSettings.byteLength > MAXIMUM_MIGRATION_SETTINGS_BYTES) {
          preservedSettings.fill(0);
          throw new Error("settings exceed the bounded migration window");
        }
        try {
          const expectedVerification = await redactedSettingsVerification(preservedSettings);
          const maybePassphrase = options.maybeBackupPassphrase;
          if (maybePassphrase !== undefined) {
            if (!input.downloadMigrationBackup) {
              throw new Error("local Migration Backup download is unavailable");
            }
            const encrypted = await encryptMigrationBackup(preservedSettings, maybePassphrase);
            try {
              await input.downloadMigrationBackup(encrypted);
            } finally {
              encrypted.fill(0);
            }
          }
          let maybeInstallFailure: unknown;
          try {
            irreversibleAttempted = true;
            await device.flash({
              image: admitted.image,
              firmwareVersion: admitted.manifest.firmwareVersion,
              targetSettingsSchema: admitted.manifest.settingsSchema.target,
              preservedSettings,
            });
            await device.reboot();
            const verification = await verifyInstalledDevice(
              device,
              admitted.manifest.firmwareVersion,
              admitted.manifest.settingsSchema.target,
              expectedVerification,
              "available",
              snapshot.partition.activeSlot === "ota_0" ? "ota_1" : "ota_0",
              "bright-builds-reference-firmware",
              true,
            );
            if (verification) {
              completed = true;
              return {
                status: "ready",
                rollback: "not_required",
                firmwareVersion: admitted.manifest.firmwareVersion,
                verification,
              };
            }
          } catch (error) {
            maybeInstallFailure = error;
          }
          maybeInstallFailure ??= new Error("post-reboot verification failed");
          try {
            const result = await rollbackAndVerify(device, snapshot, expectedVerification);
            completed = true;
            return result;
          } catch (recoveryError) {
            throw new AggregateError(
              [maybeInstallFailure, recoveryError],
              "Bitaxe installation and recovery both failed",
            );
          }
        } finally {
          preservedSettings.fill(0);
        }
      } finally {
        state = completed || irreversibleAttempted ? "completed" : "connected";
      }
    },
  };
}

async function rollbackAndVerify(
  device: BitaxeOnboardingDevice,
  snapshot: BitaxeDeviceSnapshot,
  expected: RedactedSettingsCategories,
): Promise<BitaxeOnboardingResult> {
  await device.rollback();
  await device.reboot();
  const rolledBack = await verifyInstalledDevice(
    device,
    snapshot.capabilities.firmware.version,
    snapshot.settingsSchemaVersion,
    expected,
    "confirmed",
    snapshot.partition.activeSlot,
    snapshot.capabilities.firmware.name,
    snapshot.capabilities.compatibility.referenceFirmware,
  );
  if (!rolledBack) {
    throw new Error("post-reboot recovery could not be established");
  }
  return {
    status: "rolled_back",
    rollback: "confirmed",
    firmwareVersion: snapshot.capabilities.firmware.version,
    verification: rolledBack,
  };
}

function verificationMatches(
  expected: RedactedSettingsCategories,
  actual: RedactedSettingsVerification,
): boolean {
  return (
    actual.preservationConfirmed &&
    canonicalJson(actual.categories) === canonicalJson(expected)
  );
}

async function verifyInstalledDevice(
  device: BitaxeOnboardingDevice,
  expectedFirmwareVersion: string,
  expectedSettingsSchema: number,
  expectedCategories: RedactedSettingsCategories,
  rollbackState: "available" | "confirmed",
  maybeExpectedSlot?: "ota_0" | "ota_1",
  expectedFirmwareName?: string,
  expectedReferenceFirmware?: boolean,
): Promise<RedactedSettingsVerification | undefined> {
  const snapshot = parseDeviceSnapshot(await device.inspect());
  const verification = parseVerification(await device.verifyRedactedSettings());
  const deviceStateMatches =
    snapshot.capabilities.firmware.version === expectedFirmwareVersion &&
    (expectedFirmwareName === undefined ||
      snapshot.capabilities.firmware.name === expectedFirmwareName) &&
    (expectedReferenceFirmware === undefined ||
      snapshot.capabilities.compatibility.referenceFirmware === expectedReferenceFirmware) &&
    snapshot.settingsSchemaVersion === expectedSettingsSchema &&
    snapshot.partition.bootable &&
    snapshot.partition.rollbackAvailable &&
    (maybeExpectedSlot === undefined || snapshot.partition.activeSlot === maybeExpectedSlot);
  const proofMatches =
    verification.runningFirmwareVersion === expectedFirmwareVersion &&
    verification.settingsSchemaVersion === expectedSettingsSchema &&
    verification.activeSlot === snapshot.partition.activeSlot &&
    verification.bootable &&
    verification.rollbackState === rollbackState &&
    verificationMatches(expectedCategories, verification);
  return deviceStateMatches && proofMatches ? verification : undefined;
}

async function redactedSettingsVerification(
  settings: Uint8Array,
): Promise<RedactedSettingsCategories> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(settings));
  } catch {
    throw new Error("settings schema cannot be safely preserved");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("settings schema cannot be safely preserved");
  }
  const record = parsed as Record<string, unknown>;
  const network = Object.fromEntries(
    Object.entries(record).filter(([key]) => key.startsWith("wifi_")),
  );
  const pool = Object.fromEntries(Object.entries(record).filter(([key]) => key === "pool"));
  return [
    {
      category: "all",
      digestSha256: await sha256(new TextEncoder().encode(canonicalJson(record))),
    },
    {
      category: "network",
      digestSha256: await sha256(new TextEncoder().encode(canonicalJson(network))),
    },
    {
      category: "pool",
      digestSha256: await sha256(new TextEncoder().encode(canonicalJson(pool))),
    },
  ];
}

async function sha256(value: Uint8Array): Promise<string> {
  return sha256Base64UrlBytes(value);
}
