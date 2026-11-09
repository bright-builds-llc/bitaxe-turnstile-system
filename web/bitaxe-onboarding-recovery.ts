import { canonicalJson } from "./headless-values";
import { encodeBase64Url } from "./crypto-bytes";
import { parseDeviceSnapshot, parseVerification } from "./bitaxe-onboarding-boundaries";
import type { SettingsCategoryHmac } from "./bitaxe-settings-hmac";
import type {
  BitaxeDeviceSnapshot,
  BitaxeOnboardingDevice,
  BitaxeOnboardingResult,
  OtaSlot,
  PartitionSlot,
  VerifiedSettingsEvidence,
} from "./bitaxe-onboarding";

/** Non-secret facts one install keeps so it can verify itself and any later rollback. */
export type InstallRecord = {
  snapshot: BitaxeDeviceSnapshot;
  nonce: Uint8Array;
  firmwareVersion: string;
  expectedInstalled: readonly SettingsCategoryHmac[];
  expectedRestored: readonly SettingsCategoryHmac[];
  backupDownloaded: boolean;
};

/** What a post-reboot inspection and verification must both show. */
export type ExpectedDeviceState = {
  firmwareVersion: string;
  settingsSchema: number;
  categories: readonly SettingsCategoryHmac[];
  nonce: Uint8Array;
  slot: PartitionSlot;
  firmwareName: string;
  referenceFirmware: boolean;
};

/** Returns the OTA slot an install writes: `ota_1` from `ota_0`, otherwise `ota_0`. */
export function inactiveSlot(activeSlot: PartitionSlot): OtaSlot {
  return activeSlot === "ota_0" ? "ota_1" : "ota_0";
}

/** Restores the previous slot and settings, reboots, and requires the original identity. */
export async function rollbackAndVerify(
  device: BitaxeOnboardingDevice,
  record: InstallRecord,
  nvsPartition: Uint8Array,
): Promise<BitaxeOnboardingResult> {
  const { snapshot } = record;
  await device.rollback({ slot: snapshot.partition.activeSlot, nvsPartition });
  await device.reboot();
  const maybeRolledBack = await verifyInstalledDevice(device, {
    firmwareVersion: snapshot.capabilities.firmware.version,
    settingsSchema: snapshot.settingsSchemaVersion,
    categories: record.expectedRestored,
    nonce: record.nonce,
    slot: snapshot.partition.activeSlot,
    firmwareName: snapshot.capabilities.firmware.name,
    referenceFirmware: snapshot.capabilities.compatibility.referenceFirmware,
  });
  if (!maybeRolledBack) {
    throw new Error("post-reboot recovery could not be established");
  }
  return {
    status: "rolled_back",
    rollback: "confirmed",
    firmwareVersion: snapshot.capabilities.firmware.version,
    verification: maybeRolledBack,
  };
}

/** Inspects and verifies the running device, returning evidence only when both views match. */
export async function verifyInstalledDevice(
  device: BitaxeOnboardingDevice,
  expected: ExpectedDeviceState,
): Promise<VerifiedSettingsEvidence | undefined> {
  const snapshot = parseDeviceSnapshot(await device.inspect());
  const { nonce: _nonce, ...verification } = parseVerification(
    await device.verifyRedactedSettings(expected.nonce.slice()),
    encodeBase64Url(expected.nonce),
  );
  const deviceStateMatches =
    snapshot.capabilities.firmware.version === expected.firmwareVersion &&
    snapshot.capabilities.firmware.name === expected.firmwareName &&
    snapshot.capabilities.compatibility.referenceFirmware === expected.referenceFirmware &&
    snapshot.settingsSchemaVersion === expected.settingsSchema &&
    snapshot.partition.bootable &&
    snapshot.partition.rollbackAvailable &&
    snapshot.partition.activeSlot === expected.slot;
  const proofMatches =
    verification.preservationConfirmed &&
    verification.runningFirmwareVersion === expected.firmwareVersion &&
    verification.settingsSchemaVersion === expected.settingsSchema &&
    verification.activeSlot === snapshot.partition.activeSlot &&
    verification.bootable &&
    canonicalJson(verification.categories) === canonicalJson(expected.categories);
  return deviceStateMatches && proofMatches ? verification : undefined;
}
