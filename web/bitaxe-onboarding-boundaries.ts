import { parseWorkerControllerCapabilities } from "./worker-controller-semantics";
import type {
  BitaxeDeviceSnapshot,
  RedactedSettingsVerification,
} from "./bitaxe-onboarding";

/** Reconstructs the exact non-secret USB snapshot admitted by onboarding. */
export function parseDeviceSnapshot(input: unknown): BitaxeDeviceSnapshot {
  const value = exactRecord(
    input,
    ["capabilities", "settingsSchemaVersion", "settingsReadable", "partition"],
    "Bitaxe onboarding snapshot is invalid",
  );
  const partition = exactRecord(
    value.partition,
    ["scheme", "appSlotBytes", "rollbackAvailable", "activeSlot", "bootable"],
    "Bitaxe onboarding snapshot is invalid",
  );
  const capabilities = parseWorkerControllerCapabilities(value.capabilities);
  if (
    !Number.isSafeInteger(value.settingsSchemaVersion) ||
    Number(value.settingsSchemaVersion) <= 0 ||
    typeof value.settingsReadable !== "boolean" ||
    partition.scheme !== "esp32-ota-ab" ||
    !Number.isSafeInteger(partition.appSlotBytes) ||
    Number(partition.appSlotBytes) <= 0 ||
    typeof partition.rollbackAvailable !== "boolean" ||
    !["ota_0", "ota_1"].includes(String(partition.activeSlot)) ||
    typeof partition.bootable !== "boolean"
  ) {
    throw new Error("Bitaxe onboarding snapshot is invalid");
  }
  return {
    capabilities,
    settingsSchemaVersion: Number(value.settingsSchemaVersion),
    settingsReadable: value.settingsReadable,
    partition: {
      scheme: "esp32-ota-ab",
      appSlotBytes: Number(partition.appSlotBytes),
      rollbackAvailable: partition.rollbackAvailable,
      activeSlot: partition.activeSlot as "ota_0" | "ota_1",
      bootable: partition.bootable,
    },
  };
}

/** Reconstructs the exact redacted proof returned after reboot. */
export function parseVerification(input: unknown): RedactedSettingsVerification {
  const value = exactRecord(
    input,
    [
      "preservationConfirmed",
      "runningFirmwareVersion",
      "settingsSchemaVersion",
      "activeSlot",
      "bootable",
      "rollbackState",
      "categories",
    ],
    "redacted settings verification is invalid",
  );
  if (!Array.isArray(value.categories)) {
    throw new Error("redacted settings verification is invalid");
  }
  const categories = value.categories.map((item) => {
    const category = exactRecord(
      item,
      ["category", "digestSha256"],
      "redacted settings verification is invalid",
    );
    if (
      !["all", "network", "pool"].includes(String(category.category)) ||
      typeof category.digestSha256 !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(category.digestSha256)
    ) {
      throw new Error("redacted settings verification is invalid");
    }
    return {
      category: category.category as "all" | "network" | "pool",
      digestSha256: category.digestSha256,
    };
  });
  if (
    typeof value.preservationConfirmed !== "boolean" ||
    typeof value.runningFirmwareVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(value.runningFirmwareVersion) ||
    !Number.isSafeInteger(value.settingsSchemaVersion) ||
    Number(value.settingsSchemaVersion) <= 0 ||
    !["ota_0", "ota_1"].includes(String(value.activeSlot)) ||
    typeof value.bootable !== "boolean" ||
    !["available", "confirmed"].includes(String(value.rollbackState)) ||
    categories.map((item) => item.category).join(",") !== "all,network,pool"
  ) {
    throw new Error("redacted settings verification is invalid");
  }
  return {
    preservationConfirmed: value.preservationConfirmed,
    runningFirmwareVersion: value.runningFirmwareVersion,
    settingsSchemaVersion: Number(value.settingsSchemaVersion),
    activeSlot: value.activeSlot as "ota_0" | "ota_1",
    bootable: value.bootable,
    rollbackState: value.rollbackState as "available" | "confirmed",
    categories,
  };
}

function exactRecord(
  input: unknown,
  keys: readonly string[],
  message: string,
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(message);
  }
  const value = input as Record<string, unknown>;
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key)) ||
    keys.some((key) => !actual.includes(key))
  ) {
    throw new Error(message);
  }
  return value;
}
