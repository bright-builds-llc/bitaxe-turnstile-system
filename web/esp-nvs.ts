import { encodeBase64Url } from "./crypto-bytes";
import { espCrc32Le } from "./esp-flash-digests";
import {
  parseNvsSettingEntries,
  SETTINGS_SCHEMA_ONE_NAMESPACE,
  type NvsSettingEntry,
  type NvsType,
} from "./bitaxe-settings-hmac";

const PAGE_BYTES = 4096;
const ENTRY_BYTES = 32;
const ENTRY_COUNT = 126;
const ENTRY_DATA_OFFSET = 64;
const NAMESPACE_INDEX = 0;
const CHUNK_ANY = 0xff;

const PAGE_STATE = {
  uninitialized: 0xffff_ffff,
  active: 0xffff_fffe,
  full: 0xffff_fffc,
  freeing: 0xffff_fff8,
} as const;
const ENTRY_STATE_WRITTEN = 0b10;

const ITEM_TYPES: Readonly<Record<number, NvsType>> = {
  0x01: "u8",
  0x11: "i8",
  0x02: "u16",
  0x12: "i16",
  0x04: "u32",
  0x14: "i32",
  0x08: "u64",
  0x18: "i64",
  0x21: "str",
};
const ITEM_BLOB_V1 = 0x41;
const ITEM_BLOB_DATA = 0x42;
const ITEM_BLOB_INDEX = 0x48;

type Item = {
  page: number;
  nsIndex: number;
  type: number;
  span: number;
  chunkIndex: number;
  key: string;
  data: Uint8Array;
  /** The bytes of the entries that follow the header, for strings and blob chunks. */
  payload: Uint8Array;
};

/**
 * Decodes the `main` namespace of a raw ESP-IDF NVS partition read through ROM, as the
 * firmware's NVS library sees it: written entries with a valid header CRC, the later page's
 * copy of a duplicated key, strings without their terminator and blobs reassembled from their
 * chunks. Throws on a corrupt page header or a value whose data CRC is wrong, since the
 * firmware could not read that setting either.
 */
export function parseNvsPartition(partition: Uint8Array): readonly NvsSettingEntry[] {
  if (partition.byteLength === 0 || partition.byteLength % PAGE_BYTES !== 0) {
    throw new Error("nvs partition size is invalid");
  }
  const items = readItems(partition);
  const namespaces = items.filter((item) => item.nsIndex === NAMESPACE_INDEX && item.type === 0x01);
  const maybeMain = namespaces.find((item) => item.key === SETTINGS_SCHEMA_ONE_NAMESPACE);
  if (!maybeMain) return [];
  const mainIndex = maybeMain.data[0];
  const latest = new Map<string, Item>();
  const chunks = new Map<string, Item>();
  for (const item of items) {
    if (item.nsIndex !== mainIndex) continue;
    if (item.type === ITEM_BLOB_DATA) {
      chunks.set(`${item.key}\u0000${String(item.chunkIndex)}`, item);
      continue;
    }
    const maybePrior = latest.get(item.key);
    if (!maybePrior || maybePrior.page <= item.page) latest.set(item.key, item);
  }
  const entries = [...latest.values()]
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .map((item) => decodeItem(item, chunks));
  return parseNvsSettingEntries(entries);
}

function readItems(partition: Uint8Array): Item[] {
  const pages: { sequence: number; at: number }[] = [];
  for (let at = 0; at < partition.byteLength; at += PAGE_BYTES) {
    const header = new DataView(partition.buffer, partition.byteOffset + at, 32);
    const state = header.getUint32(0, true);
    if (state === PAGE_STATE.uninitialized) continue;
    if (state !== PAGE_STATE.active && state !== PAGE_STATE.full && state !== PAGE_STATE.freeing) {
      throw new Error("nvs page is corrupt");
    }
    if (espCrc32Le(0xffff_ffff, partition.subarray(at + 4, at + 28)) !== header.getUint32(28, true)) {
      throw new Error("nvs page header is corrupt");
    }
    pages.push({ sequence: header.getUint32(4, true), at });
  }
  pages.sort((left, right) => left.sequence - right.sequence);
  return pages.flatMap((page, order) => readPageItems(partition, page.at, order));
}

function readPageItems(partition: Uint8Array, pageAt: number, order: number): Item[] {
  const states = partition.subarray(pageAt + 32, pageAt + ENTRY_DATA_OFFSET);
  const items: Item[] = [];
  let index = 0;
  while (index < ENTRY_COUNT) {
    if (entryState(states, index) !== ENTRY_STATE_WRITTEN) {
      index += 1;
      continue;
    }
    const at = pageAt + ENTRY_DATA_OFFSET + index * ENTRY_BYTES;
    const entry = partition.subarray(at, at + ENTRY_BYTES);
    const span = entry[2] ?? 0;
    if (!headerConsistent(entry) || span === 0 || index + span > ENTRY_COUNT) {
      index += 1;
      continue;
    }
    items.push({
      page: order,
      nsIndex: entry[0] ?? 0,
      type: entry[1] ?? 0,
      span,
      chunkIndex: entry[3] ?? 0,
      key: itemKey(entry.subarray(8, 24)),
      data: entry.subarray(24, 32),
      payload: partition.subarray(at + ENTRY_BYTES, at + span * ENTRY_BYTES),
    });
    index += span;
  }
  return items;
}

function decodeItem(item: Item, chunks: ReadonlyMap<string, Item>): NvsSettingEntry {
  const maybeInteger = ITEM_TYPES[item.type];
  if (maybeInteger && maybeInteger !== "str") {
    return { key: item.key, type: maybeInteger, value: integerValue(maybeInteger, item.data) };
  }
  if (item.type === 0x21) {
    const bytes = variableData(item);
    if (bytes.at(-1) !== 0) throw new Error("nvs string has no terminator");
    return {
      key: item.key,
      type: "str",
      value: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, -1)),
    };
  }
  if (item.type === ITEM_BLOB_V1 && item.chunkIndex === CHUNK_ANY) {
    return { key: item.key, type: "blob", value: encodeBase64Url(variableData(item)) };
  }
  if (item.type === ITEM_BLOB_INDEX) {
    return { key: item.key, type: "blob", value: encodeBase64Url(blobFromChunks(item, chunks)) };
  }
  throw new Error("nvs item type is unsupported");
}

function variableData(item: Item): Uint8Array {
  const view = new DataView(item.data.buffer, item.data.byteOffset, 8);
  const size = view.getUint16(0, true);
  if (size > item.payload.byteLength) throw new Error("nvs value overruns its span");
  const bytes = item.payload.subarray(0, size);
  if (espCrc32Le(0xffff_ffff, bytes) !== view.getUint32(4, true)) {
    throw new Error("nvs value data is corrupt");
  }
  return bytes;
}

function blobFromChunks(index: Item, chunks: ReadonlyMap<string, Item>): Uint8Array {
  const view = new DataView(index.data.buffer, index.data.byteOffset, 8);
  const size = view.getUint32(0, true);
  const chunkCount = view.getUint8(4);
  const chunkStart = view.getUint8(5);
  const parts: Uint8Array[] = [];
  for (let chunk = 0; chunk < chunkCount; chunk += 1) {
    const maybeChunk = chunks.get(`${index.key}\u0000${String(chunkStart + chunk)}`);
    if (!maybeChunk) throw new Error("nvs blob chunk is missing");
    parts.push(variableData(maybeChunk));
  }
  const blob = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    blob.set(part, offset);
    offset += part.byteLength;
  }
  if (blob.byteLength !== size) throw new Error("nvs blob size is inconsistent");
  return blob;
}

function integerValue(type: NvsType, data: Uint8Array): string {
  const view = new DataView(data.buffer, data.byteOffset, 8);
  switch (type) {
    case "u8":
      return String(view.getUint8(0));
    case "i8":
      return String(view.getInt8(0));
    case "u16":
      return String(view.getUint16(0, true));
    case "i16":
      return String(view.getInt16(0, true));
    case "u32":
      return String(view.getUint32(0, true));
    case "i32":
      return String(view.getInt32(0, true));
    case "u64":
      return view.getBigUint64(0, true).toString();
    case "i64":
      return view.getBigInt64(0, true).toString();
    default:
      throw new Error("nvs integer type is invalid");
  }
}

/** Mirrors `Item::calculateCrc32`: the header bytes, key and data, without the CRC field. */
function headerConsistent(entry: Uint8Array): boolean {
  const view = new DataView(entry.buffer, entry.byteOffset, ENTRY_BYTES);
  const crc = espCrc32Le(espCrc32Le(0xffff_ffff, entry.subarray(0, 4)), entry.subarray(8, 32));
  return crc === view.getUint32(4, true);
}

function entryState(states: Uint8Array, index: number): number {
  const byte = states[Math.floor(index / 4)] ?? 0xff;
  return (byte >> ((index % 4) * 2)) & 0b11;
}

function itemKey(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder("ascii").decode(bytes.subarray(0, end === -1 ? bytes.length : end));
}
