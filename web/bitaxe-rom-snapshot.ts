import { WORKER_CONTROLLER_PROTOCOL_VERSION } from "./worker-controller";
import { encodeBase64Url } from "./crypto-bytes";
import { maybeAppDescriptor, semanticFirmwareVersion, type AppDescriptor } from "./esp-app-image";
import { parseNvsPartition } from "./esp-nvs";
import { selectedBootSlot, selectionIsBootable } from "./esp-otadata";
import { partitionLayout, type KnownPartitionTable } from "./esp-partition-table";
import { maybeReferenceFirmwareBoardByRevision } from "./reference-firmware-board";
import { settingsCategoryHmacs, type NvsSettingEntry } from "./bitaxe-settings-hmac";
import type { BitaxeDeviceSnapshot, RedactedSettingsVerification } from "./bitaxe-onboarding";
import type { WorkerControllerCapabilities } from "./worker-controller-semantics";

/** Every settings schema an ESP-Miner build can have (ADR-0111). */
const ROM_SETTINGS_SCHEMA = 1;

/** Flash regions read through ROM that describe the running image without Worker Serial. */
export type RomFlashView = {
  table: KnownPartitionTable;
  otadata: Uint8Array;
  /** The first bytes of the slot `otadata` selects. */
  runningSlotStart: Uint8Array;
  nvsPartition: Uint8Array;
};

/**
 * A reference image built before Ticket 03 that Worker Serial admitted (Hello and possession) but
 * that has no onboarding commands: its signed capabilities, and the app descriptor it ran under.
 */
export type AdmittedImage = {
  capabilities: WorkerControllerCapabilities;
  descriptor: AppDescriptor;
};

/** What the browser learns from flash alone, before or after any write. */
export type RomInspection = {
  snapshot: BitaxeDeviceSnapshot;
  entries: readonly NvsSettingEntry[];
};

/**
 * Builds the onboarding snapshot of an image that has no Worker Serial, such as stock ESP-Miner,
 * from flash read through ROM. The board comes from NVS `boardversion` within the closed set of
 * ADR-0104; the firmware from the running slot's `esp_app_desc_t`. The image is never Reference
 * Firmware, so settings preservation is `upgrade_required`; the controller literals are the
 * type's only values and claim nothing about the image. Settings that don't parse throw, since
 * the board's identity is one of them. `rollbackAvailable` means the browser's
 * rollback (ADR-0111): a known table lets it keep the running slot untouched and restore NVS.
 *
 * With `maybeAdmitted`, and only while the running slot carries the descriptor it was admitted
 * under, the firmware and Reference Firmware claim come from its signed capabilities instead, since
 * a `git describe` descriptor names no release (ADR-0112). It still can't preserve settings.
 */
export function inspectFlash(view: RomFlashView, maybeAdmitted?: AdmittedImage): RomInspection {
  const selection = selectedBootSlot(view.otadata);
  const maybeDescriptor = maybeAppDescriptor(view.runningSlotStart);
  if (!maybeDescriptor) throw new Error("the running slot holds no app image");
  const entries = parseNvsPartition(view.nvsPartition);
  const maybeRevision = entries.find((entry) => entry.key === "boardversion")?.value;
  const maybeBoard = maybeReferenceFirmwareBoardByRevision(maybeRevision);
  if (!maybeBoard) throw new Error("the board is not a supported Reference Firmware board");
  const layout = partitionLayout(view.table);
  const maybeSigned = maybeAdmitted && sameDescriptor(maybeAdmitted.descriptor, maybeDescriptor)
    ? maybeAdmitted.capabilities
    : undefined;
  if (maybeSigned && (maybeSigned.board.model !== maybeBoard.model || maybeSigned.board.revision !== maybeBoard.revision)) {
    throw new Error("the board's settings and its signed capability name different boards");
  }
  return {
    entries,
    snapshot: {
      capabilities: {
        protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION,
        board: { model: maybeBoard.model, revision: maybeBoard.revision, usbTransport: "web_serial" },
        firmware: maybeSigned
          ? { name: maybeSigned.firmware.name, version: maybeSigned.firmware.version }
          : { name: maybeDescriptor.projectName, version: semanticFirmwareVersion(maybeDescriptor.version) },
        compatibility: {
          referenceFirmware: maybeSigned?.compatibility.referenceFirmware ?? false,
          workLease: "supported",
          miningBaselineRestoration: "supported",
          settingsPreservation: "upgrade_required",
        },
      },
      settingsSchemaVersion: ROM_SETTINGS_SCHEMA,
      settingsReadable: true,
      partition: {
        scheme: "esp32-factory-ota-ab",
        appSlotBytes: Math.min(layout.ota_0.size, layout.ota_1.size),
        rollbackAvailable: true,
        activeSlot: selection.slot,
        bootable: selectionIsBootable(selection),
      },
    },
  };
}

/**
 * The redacted verification of an image without Worker Serial, taken from flash: the HMACs are
 * the browser's own over the NVS it read back, so it proves what flash holds, not what the image
 * read at boot. `preservationConfirmed` needs a bootable selection and readable settings.
 */
export async function verifyFlash(
  view: RomFlashView,
  nonce: Uint8Array,
  maybeAdmitted?: AdmittedImage,
): Promise<RedactedSettingsVerification> {
  const { snapshot, entries } = inspectFlash(view, maybeAdmitted);
  return {
    preservationConfirmed: snapshot.partition.bootable,
    runningFirmwareVersion: snapshot.capabilities.firmware.version,
    settingsSchemaVersion: snapshot.settingsSchemaVersion,
    activeSlot: snapshot.partition.activeSlot,
    bootable: snapshot.partition.bootable,
    nonce: encodeBase64Url(nonce),
    categories: await settingsCategoryHmacs(entries, ROM_SETTINGS_SCHEMA, nonce),
  };
}

function sameDescriptor(left: AppDescriptor, right: AppDescriptor): boolean {
  return left.projectName === right.projectName && left.version === right.version;
}
