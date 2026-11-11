import { md5 } from "./esp-flash-digests";

/** Flash offset of the ESP-IDF partition table on ESP32-S3. */
export const PARTITION_TABLE_OFFSET = 0x8000;
/** The table region ESP-IDF reserves and the browser reads: entries, MD5 entry, `0xFF` fill. */
export const PARTITION_TABLE_BYTES = 0xc00;
/** Flash offset of the second-stage bootloader on ESP32-S3. */
export const BOOTLOADER_OFFSET = 0x0;
/** Bytes before the partition table, the most a bootloader may occupy. */
export const MAXIMUM_BOOTLOADER_BYTES = PARTITION_TABLE_OFFSET - BOOTLOADER_OFFSET;

const ENTRY_BYTES = 32;
const ENTRY_MAGIC = [0xaa, 0x50] as const;
const MD5_MAGIC = [0xeb, 0xeb] as const;

/** One partition table row, as `gen_esp32part.py` encodes it. */
export type PartitionEntry = {
  label: string;
  type: number;
  subtype: number;
  offset: number;
  size: number;
  flags: number;
};

/** The two tables onboarding accepts; every other table is refused before any write. */
export type KnownPartitionTable = "upstream" | "c";

const sharedEntries: readonly PartitionEntry[] = [
  { label: "nvs", type: 0x01, subtype: 0x02, offset: 0x9000, size: 0x6000, flags: 0 },
  { label: "phy_init", type: 0x01, subtype: 0x01, offset: 0xf000, size: 0x1000, flags: 0 },
  { label: "factory", type: 0x00, subtype: 0x00, offset: 0x10000, size: 0x400000, flags: 0 },
  { label: "www", type: 0x01, subtype: 0x82, offset: 0x410000, size: 0x300000, flags: 0 },
  { label: "ota_0", type: 0x00, subtype: 0x10, offset: 0x710000, size: 0x400000, flags: 0 },
  { label: "ota_1", type: 0x00, subtype: 0x11, offset: 0xb10000, size: 0x400000, flags: 0 },
  { label: "otadata", type: 0x01, subtype: 0x00, offset: 0xf10000, size: 0x2000, flags: 0 },
];

/**
 * Upstream ESP-Miner's `partitions.csv` and the C image's, which differ only in coredump:
 * upstream keeps 64 KiB after `otadata`, the C table runs it to the end of the 16 MiB flash.
 */
export const KNOWN_PARTITION_TABLES: Readonly<Record<KnownPartitionTable, readonly PartitionEntry[]>> = {
  upstream: [
    ...sharedEntries,
    { label: "coredump", type: 0x01, subtype: 0x03, offset: 0xf12000, size: 0x10000, flags: 0 },
  ],
  c: [
    ...sharedEntries,
    { label: "coredump", type: 0x01, subtype: 0x03, offset: 0xf12000, size: 0xee000, flags: 0 },
  ],
};

/** Flash regions onboarding reads and writes, identical in both known tables. */
export type PartitionLayout = Readonly<
  Record<"nvs" | "otadata" | "factory" | "ota_0" | "ota_1", { offset: number; size: number }>
>;

/** Returns the regions onboarding uses from a known table. */
export function partitionLayout(table: KnownPartitionTable): PartitionLayout {
  const region = (label: string) => {
    const maybeEntry = KNOWN_PARTITION_TABLES[table].find((entry) => entry.label === label);
    if (!maybeEntry) throw new Error(`partition ${label} is missing`);
    return { offset: maybeEntry.offset, size: maybeEntry.size };
  };
  return {
    nvs: region("nvs"),
    otadata: region("otadata"),
    factory: region("factory"),
    ota_0: region("ota_0"),
    ota_1: region("ota_1"),
  };
}

/**
 * Names the table read from `0x8000`, or throws. A table is known only when its rows equal
 * one known table exactly, its MD5 row matches, and the rest of the region is erased.
 */
export function classifyPartitionTable(region: Uint8Array): KnownPartitionTable {
  const entries = parsePartitionTable(region);
  const maybeKnown = (Object.keys(KNOWN_PARTITION_TABLES) as KnownPartitionTable[]).find((name) =>
    sameEntries(entries, KNOWN_PARTITION_TABLES[name]),
  );
  if (!maybeKnown) throw new Error("partition table is neither upstream's nor the C image's");
  return maybeKnown;
}

/** Encodes rows as `gen_esp32part.py` does: rows, MD5 row, `0xFF` to the region's end. */
export function encodePartitionTable(entries: readonly PartitionEntry[]): Uint8Array {
  const region = new Uint8Array(PARTITION_TABLE_BYTES).fill(0xff);
  const view = new DataView(region.buffer);
  entries.forEach((entry, index) => {
    const at = index * ENTRY_BYTES;
    region.set(ENTRY_MAGIC, at);
    region[at + 2] = entry.type;
    region[at + 3] = entry.subtype;
    view.setUint32(at + 4, entry.offset, true);
    view.setUint32(at + 8, entry.size, true);
    region.fill(0, at + 12, at + 28);
    region.set(new TextEncoder().encode(entry.label), at + 12);
    view.setUint32(at + 28, entry.flags, true);
  });
  const md5At = entries.length * ENTRY_BYTES;
  region.set(MD5_MAGIC, md5At);
  region.set(md5(region.subarray(0, md5At)), md5At + 16);
  return region;
}

function parsePartitionTable(region: Uint8Array): PartitionEntry[] {
  if (region.byteLength !== PARTITION_TABLE_BYTES) throw new Error("partition table read is incomplete");
  const view = new DataView(region.buffer, region.byteOffset, region.byteLength);
  const entries: PartitionEntry[] = [];
  for (let at = 0; at + ENTRY_BYTES <= region.byteLength; at += ENTRY_BYTES) {
    if (region[at] === MD5_MAGIC[0] && region[at + 1] === MD5_MAGIC[1]) {
      requireMd5Row(region, at);
      return entries;
    }
    if (region[at] !== ENTRY_MAGIC[0] || region[at + 1] !== ENTRY_MAGIC[1]) break;
    entries.push({
      label: label(region.subarray(at + 12, at + 28)),
      type: region[at + 2] ?? 0,
      subtype: region[at + 3] ?? 0,
      offset: view.getUint32(at + 4, true),
      size: view.getUint32(at + 8, true),
      flags: view.getUint32(at + 28, true),
    });
  }
  throw new Error("partition table has no MD5 row");
}

function requireMd5Row(region: Uint8Array, at: number): void {
  const expected = md5(region.subarray(0, at));
  const actual = region.subarray(at + 16, at + 32);
  if (
    !region.subarray(at + 2, at + 16).every((byte) => byte === 0xff) ||
    !expected.every((byte, index) => byte === actual[index]) ||
    !region.subarray(at + 32).every((byte) => byte === 0xff)
  ) {
    throw new Error("partition table MD5 row is invalid");
  }
}

function label(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  const text = bytes.subarray(0, end === -1 ? bytes.length : end);
  if (end !== -1 && !bytes.subarray(end).every((byte) => byte === 0)) {
    throw new Error("partition label is invalid");
  }
  return new TextDecoder("ascii", { fatal: true }).decode(text);
}

function sameEntries(actual: readonly PartitionEntry[], expected: readonly PartitionEntry[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((entry, index) => {
      const other = expected[index];
      return (
        other !== undefined &&
        entry.label === other.label &&
        entry.type === other.type &&
        entry.subtype === other.subtype &&
        entry.offset === other.offset &&
        entry.size === other.size &&
        entry.flags === other.flags
      );
    })
  );
}
