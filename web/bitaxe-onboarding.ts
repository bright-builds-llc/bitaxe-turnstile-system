import type { WorkerControllerCapabilities } from "./worker-controller-semantics";
import { parseDeviceSnapshot } from "./bitaxe-onboarding-boundaries";
import {
  admitFirmwarePackage,
  type FirmwarePackage,
  type UpdateAuthorityJwk,
} from "./bitaxe-firmware-package";
import {
  decryptMigrationBackup,
  encryptMigrationBackup,
  MAXIMUM_MIGRATION_SETTINGS_BYTES,
} from "./bitaxe-migration-backup";
import {
  parseNvsSettingEntries,
  randomSettingsNonce,
  settingsCategoryHmacs,
  type NvsSettingEntry,
  type SettingsCategoryHmac,
} from "./bitaxe-settings-hmac";
import {
  inactiveSlot,
  rollbackAndVerify,
  verifyInstalledDevice,
  type InstallRecord,
} from "./bitaxe-onboarding-recovery";
export {
  decryptMigrationBackup,
  MAXIMUM_MIGRATION_SETTINGS_BYTES,
} from "./bitaxe-migration-backup";
export {
  SETTINGS_HMAC_NONCE_BYTES,
  SETTINGS_HMAC_PROFILE,
  SETTINGS_SCHEMA_KEYS,
  settingsCategoryHmacs,
  settingsCategoryMessage,
  type NvsSettingEntry,
  type NvsType,
  type SettingsCategory,
  type SettingsCategoryHmac,
} from "./bitaxe-settings-hmac";

export {
  MAXIMUM_FIRMWARE_IMAGE_BYTES,
  type FirmwareManifest,
  type FirmwarePackage,
  type UpdateAuthorityJwk,
} from "./bitaxe-firmware-package";

/** App slots of upstream ESP-Miner's and the C image's `esp32-factory-ota-ab` table. */
export type PartitionSlot = "factory" | "ota_0" | "ota_1";
/** OTA slots the browser may write; `factory` is never written. */
export type OtaSlot = Exclude<PartitionSlot, "factory">;

/** Non-secret local facts needed to decide whether flashing can be safe. */
export type BitaxeDeviceSnapshot = {
  capabilities: WorkerControllerCapabilities;
  settingsSchemaVersion: number;
  settingsReadable: boolean;
  partition: {
    scheme: "esp32-factory-ota-ab";
    appSlotBytes: number;
    rollbackAvailable: boolean;
    activeSlot: PartitionSlot;
    bootable: boolean;
  };
};

/** Redacted post-reboot proof, keyed by the nonce the browser sent, that settings were kept. */
export type RedactedSettingsVerification = {
  preservationConfirmed: boolean;
  runningFirmwareVersion: string;
  settingsSchemaVersion: number;
  activeSlot: PartitionSlot;
  bootable: boolean;
  /** The browser's nonce echoed as base64url; a reply under any other nonce is refused. */
  nonce: string;
  categories: readonly SettingsCategoryHmac[];
};

/** Verified evidence returned to callers; the nonce stays inside onboarding. */
export type VerifiedSettingsEvidence = Omit<RedactedSettingsVerification, "nonce">;

/** The raw `nvs` partition read through ROM and its decoded `main` namespace entries. */
export type MigrationSettings = {
  nvsPartition: Uint8Array;
  entries: readonly NvsSettingEntry[];
};

/** USB device operations required by the browser onboarding state machine. */
export interface BitaxeOnboardingDevice {
  /** Reads a strict, non-secret snapshot without changing device state. */
  inspect(): Promise<BitaxeDeviceSnapshot>;
  /** Returns a caller-owned copy of the raw `nvs` partition, no larger than `maximumBytes`. */
  readMigrationSettings(maximumBytes: number): Promise<MigrationSettings>;
  /** Writes the image to the inactive OTA slot and sets `otadata` to boot it pending; never NVS. */
  flash(input: { image: Uint8Array; firmwareVersion: string; targetSlot: OtaSlot }): Promise<void>;
  /** Reboots into the selected slot and resolves only after device continuity is restored. */
  reboot(): Promise<void>;
  /** Returns strict redacted proof with every category HMAC keyed by `nonce`. */
  verifyRedactedSettings(nonce: Uint8Array): Promise<RedactedSettingsVerification>;
  /** Points `otadata` at the untouched previous slot and writes the raw `nvs` partition back. */
  rollback(input: { slot: PartitionSlot; nvsPartition: Uint8Array }): Promise<void>;
}

/** Strict non-secret inspection returned after the user selects a local device. */
export type BitaxeOnboardingInspection = {
  action: "ready" | "firmware_required";
  capabilities: WorkerControllerCapabilities;
  settingsSchemaVersion: number;
  /** `recommended` for a first install from stock, where a later rollback needs the download. */
  migrationBackup: "recommended" | "optional";
};

/** Terminal, redacted evidence that installation or verified rollback completed safely. */
export type BitaxeOnboardingResult = {
  status: "ready" | "rolled_back";
  rollback: "not_required" | "confirmed";
  firmwareVersion: string;
  verification: VerifiedSettingsEvidence;
};

/**
 * Whether a ready install can still be rolled back: `available` while the in-memory copy
 * exists, `backup_required` once it is wiped but a Migration Backup was downloaded.
 */
export type BitaxeRollbackState = "available" | "backup_required" | "unavailable";

/** Single-device, single-install onboarding lifecycle. */
export type BitaxeOnboarding = {
  /** Explicit user-action seam that alone may request local USB device access. */
  connect(): Promise<BitaxeOnboardingInspection>;
  /** Verifies, reads, flashes, reboots, and redacted-verifies one admitted package. */
  install(
    firmwarePackage: FirmwarePackage,
    options?: { maybeBackupPassphrase?: string },
  ): Promise<BitaxeOnboardingResult>;
  /** Reports whether the ready install can be rolled back, and with what. */
  rollbackState(): BitaxeRollbackState;
  /** Ends onboarding for the user and wipes the in-memory rollback copy. */
  complete(): void;
  /** Rolls a ready install back from the in-memory copy, or from the user's download. */
  rollBack(options?: {
    maybeMigrationBackup?: { encryptedBackup: Uint8Array; passphrase: string };
  }): Promise<BitaxeOnboardingResult>;
};

type OnboardingState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "installing"
  | "installed"
  | "rolling_back"
  | "completed";

/** Creates accountless browser onboarding without network or mobile/account dependencies. */
export function createBitaxeOnboarding(input: {
  requestDevice: () => Promise<BitaxeOnboardingDevice>;
  trustedUpdateKeys?: readonly UpdateAuthorityJwk[];
  /** Persists a borrowed encrypted buffer before return; onboarding wipes it on every exit. */
  downloadMigrationBackup?: (encryptedBackup: Uint8Array) => Promise<void>;
}): BitaxeOnboarding {
  let maybeDevice: BitaxeOnboardingDevice | undefined;
  let maybeSnapshot: BitaxeDeviceSnapshot | undefined;
  let maybeInstall: InstallRecord | undefined;
  let maybeRollbackCopy: Uint8Array | undefined;
  let state: OnboardingState = "disconnected";

  const wipeRollbackCopy = (): void => {
    maybeRollbackCopy?.fill(0);
    maybeRollbackCopy = undefined;
  };

  const recover = async (
    device: BitaxeOnboardingDevice,
    record: InstallRecord,
    nvsPartition: Uint8Array,
  ): Promise<BitaxeOnboardingResult> => {
    const result = await rollbackAndVerify(device, record, nvsPartition);
    maybeInstall = undefined;
    return result;
  };

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
        const compatibility = snapshot.capabilities.compatibility;
        return {
          action:
            compatibility.referenceFirmware && compatibility.settingsPreservation === "compatible"
              ? "ready"
              : "firmware_required",
          capabilities: structuredClone(snapshot.capabilities),
          settingsSchemaVersion: snapshot.settingsSchemaVersion,
          migrationBackup: compatibility.referenceFirmware ? "optional" : "recommended",
        };
      } finally {
        if (state === "connecting") state = "disconnected";
      }
    },
    async install(firmwarePackage, options = {}) {
      if (state !== "connected") {
        throw new Error(
          state === "disconnected" || state === "connecting"
            ? "Bitaxe USB connection is required"
            : "Bitaxe onboarding install is already active",
        );
      }
      const device = maybeDevice;
      const snapshot = maybeSnapshot;
      if (!device || !snapshot) throw new Error("Bitaxe USB connection is required");
      state = "installing";
      let irreversibleAttempted = false;
      try {
        const admitted = await admitFirmwarePackage(
          firmwarePackage,
          input.trustedUpdateKeys ?? [],
          snapshot,
        );
        if (!snapshot.settingsReadable) {
          throw new Error("firmware package is not safely compatible");
        }
        const migration = await device.readMigrationSettings(MAXIMUM_MIGRATION_SETTINGS_BYTES);
        maybeRollbackCopy = migration.nvsPartition;
        if (migration.nvsPartition.byteLength > MAXIMUM_MIGRATION_SETTINGS_BYTES) {
          throw new Error("settings exceed the bounded migration window");
        }
        const entries = parseNvsSettingEntries(migration.entries);
        const nonce = randomSettingsNonce();
        const target = admitted.manifest.settingsSchema.target;
        const record: InstallRecord = {
          snapshot,
          nonce,
          firmwareVersion: admitted.manifest.firmwareVersion,
          expectedInstalled: await settingsCategoryHmacs(entries, target, nonce),
          expectedRestored: await settingsCategoryHmacs(
            entries,
            snapshot.settingsSchemaVersion,
            nonce,
          ),
          backupDownloaded: false,
        };
        const maybePassphrase = options.maybeBackupPassphrase;
        if (maybePassphrase !== undefined) {
          await downloadBackup(input.downloadMigrationBackup, migration.nvsPartition, maybePassphrase);
          record.backupDownloaded = true;
        }
        let maybeInstallFailure: unknown;
        try {
          irreversibleAttempted = true;
          const targetSlot = inactiveSlot(snapshot.partition.activeSlot);
          await device.flash({
            image: admitted.image,
            firmwareVersion: record.firmwareVersion,
            targetSlot,
          });
          await device.reboot();
          const maybeVerification = await verifyInstalledDevice(device, {
            firmwareVersion: record.firmwareVersion,
            settingsSchema: target,
            categories: record.expectedInstalled,
            nonce,
            slot: targetSlot,
            firmwareName: "bright-builds-reference-firmware",
            referenceFirmware: true,
          });
          if (maybeVerification) {
            maybeInstall = record;
            state = "installed";
            return {
              status: "ready",
              rollback: "not_required",
              firmwareVersion: record.firmwareVersion,
              verification: maybeVerification,
            };
          }
        } catch (error) {
          maybeInstallFailure = error;
        }
        maybeInstallFailure ??= new Error("post-reboot verification failed");
        try {
          return await recover(device, record, migration.nvsPartition);
        } catch (recoveryError) {
          throw new AggregateError(
            [maybeInstallFailure, recoveryError],
            "Bitaxe installation and recovery both failed",
          );
        }
      } finally {
        if (state !== "installed") {
          wipeRollbackCopy();
          state = irreversibleAttempted ? "completed" : "connected";
        }
      }
    },
    rollbackState() {
      if (maybeRollbackCopy && maybeInstall) return "available";
      return maybeInstall?.backupDownloaded ? "backup_required" : "unavailable";
    },
    complete() {
      wipeRollbackCopy();
      if (state === "installed" && !maybeInstall?.backupDownloaded) maybeInstall = undefined;
      if (state === "installed" || state === "connected") state = "completed";
    },
    async rollBack(options = {}) {
      const device = maybeDevice;
      const record = maybeInstall;
      if (state === "rolling_back") throw new Error("Bitaxe rollback is already active");
      if (!device || !record) throw new Error("Bitaxe install cannot be rolled back");
      const previousState = state;
      state = "rolling_back";
      let maybePartition: Uint8Array | undefined;
      try {
        maybePartition =
          maybeRollbackCopy ?? (await decryptSuppliedBackup(options.maybeMigrationBackup));
        return await recover(device, record, maybePartition);
      } finally {
        maybePartition?.fill(0);
        wipeRollbackCopy();
        state = maybeInstall ? previousState : "completed";
      }
    },
  };
}

async function downloadBackup(
  maybeDownload: ((encryptedBackup: Uint8Array) => Promise<void>) | undefined,
  nvsPartition: Uint8Array,
  passphrase: string,
): Promise<void> {
  if (!maybeDownload) throw new Error("local Migration Backup download is unavailable");
  const encrypted = await encryptMigrationBackup(nvsPartition, passphrase);
  try {
    await maybeDownload(encrypted);
  } finally {
    encrypted.fill(0);
  }
}

async function decryptSuppliedBackup(
  maybeBackup: { encryptedBackup: Uint8Array; passphrase: string } | undefined,
): Promise<Uint8Array> {
  if (!maybeBackup) throw new Error("Bitaxe rollback needs the Migration Backup download");
  return decryptMigrationBackup(maybeBackup.encryptedBackup, maybeBackup.passphrase);
}
