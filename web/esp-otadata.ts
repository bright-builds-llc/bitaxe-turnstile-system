import { espCrc32Le } from "./esp-flash-digests";
import type { OtaSlot, PartitionSlot } from "./bitaxe-onboarding";

/** `otadata` is two erase sectors, each holding one `esp_ota_select_entry_t` at its start. */
export const OTADATA_SECTOR_BYTES = 0x1000;
/** Bytes of the whole `otadata` partition in both known tables. */
export const OTADATA_BYTES = 2 * OTADATA_SECTOR_BYTES;

/** ESP-IDF `esp_ota_img_states_t` values. */
export const OTA_IMAGE_STATE = {
  new: 0x0,
  pendingVerify: 0x1,
  valid: 0x2,
  invalid: 0x3,
  aborted: 0x4,
  undefined: 0xffff_ffff,
} as const;

const OTA_APP_COUNT = 2;
const ENTRY_BYTES = 32;
const OTA_SLOTS: readonly OtaSlot[] = ["ota_0", "ota_1"];

type SelectEntry = { seq: number; state: number; crc: number };

/** The slot the bootloader will start and, for an OTA slot, the state of its entry. */
export type OtadataSelection =
  | { slot: "factory" }
  | { slot: OtaSlot; state: number; sector: 0 | 1 };

/** Mirrors `bootloader_common_get_active_otadata`; with no valid entry, `factory` boots. */
export function selectedBootSlot(otadata: Uint8Array): OtadataSelection {
  const entries = readEntries(otadata);
  const maybeSector = activeSector(entries);
  if (maybeSector === undefined) return { slot: "factory" };
  const entry = entries[maybeSector];
  const slot = OTA_SLOTS[(entry.seq - 1) % OTA_APP_COUNT];
  if (!slot) throw new Error("otadata selects no slot");
  return { slot, state: entry.state, sector: maybeSector };
}

/** Whether the selected image runs without a pending trial: `factory`, `VALID` or `UNDEFINED`. */
export function selectionIsBootable(selection: OtadataSelection): boolean {
  return (
    selection.slot === "factory" ||
    selection.state === OTA_IMAGE_STATE.valid ||
    selection.state === OTA_IMAGE_STATE.undefined
  );
}

/**
 * Returns `otadata` rewritten so `slot` boots, as `esp_ota_set_boot_partition` does it: `factory`
 * erases both sectors; an OTA slot gets the next sequence number in the other sector (or its
 * own sector when it is already selected) with `state`. An install passes `new`, so the C
 * bootloader boots it pending; a rollback passes `valid` for the untouched previous image.
 */
export function otadataBooting(otadata: Uint8Array, slot: PartitionSlot, state: number): Uint8Array {
  const entries = readEntries(otadata);
  if (slot === "factory") return new Uint8Array(OTADATA_BYTES).fill(0xff);
  const slotIndex = OTA_SLOTS.indexOf(slot);
  const maybeActive = activeSector(entries);
  let sector: 0 | 1 = 0;
  let seq = slotIndex + 1;
  if (maybeActive !== undefined) {
    const activeSeq = entries[maybeActive].seq;
    if ((activeSeq - 1) % OTA_APP_COUNT === slotIndex) {
      sector = maybeActive;
      seq = activeSeq;
    } else {
      sector = maybeActive === 0 ? 1 : 0;
      seq = nextSeqFor(activeSeq, slotIndex);
    }
  }
  const rewritten = otadata.slice();
  const at = sector * OTADATA_SECTOR_BYTES;
  rewritten.fill(0xff, at, at + OTADATA_SECTOR_BYTES);
  const view = new DataView(rewritten.buffer, at, ENTRY_BYTES);
  view.setUint32(0, seq, true);
  view.setUint32(24, state >>> 0, true);
  view.setUint32(28, seqCrc(seq), true);
  return rewritten;
}

function readEntries(otadata: Uint8Array): [SelectEntry, SelectEntry] {
  if (otadata.byteLength !== OTADATA_BYTES) throw new Error("otadata read is incomplete");
  const entry = (sector: 0 | 1): SelectEntry => {
    const view = new DataView(otadata.buffer, otadata.byteOffset + sector * OTADATA_SECTOR_BYTES, ENTRY_BYTES);
    return { seq: view.getUint32(0, true), state: view.getUint32(24, true), crc: view.getUint32(28, true) };
  };
  return [entry(0), entry(1)];
}

function activeSector(entries: [SelectEntry, SelectEntry]): 0 | 1 | undefined {
  const valid = entries.map(
    (entry) =>
      entry.seq !== 0xffff_ffff &&
      entry.state !== OTA_IMAGE_STATE.invalid &&
      entry.state !== OTA_IMAGE_STATE.aborted &&
      entry.crc === seqCrc(entry.seq),
  );
  if (valid[0] && valid[1]) return entries[0].seq >= entries[1].seq ? 0 : 1;
  if (valid[0]) return 0;
  if (valid[1]) return 1;
  return undefined;
}

/** `compute_ota_seq_for_target_slot`: the smallest sequence at least `current` that boots the slot. */
function nextSeqFor(current: number, slotIndex: number): number {
  const base = (slotIndex + 1) % OTA_APP_COUNT;
  let round = 0;
  while (current > base + round * OTA_APP_COUNT) round += 1;
  return base + round * OTA_APP_COUNT;
}

function seqCrc(seq: number): number {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, seq, true);
  return espCrc32Le(0xffff_ffff, bytes);
}
