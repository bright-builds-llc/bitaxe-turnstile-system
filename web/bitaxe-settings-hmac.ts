import { decodeBase64Url, encodeBase64Url } from "./crypto-bytes";

/** Domain prefix of every settings HMAC message; the suffix is the encoding version. */
export const SETTINGS_HMAC_PROFILE = "bwg-settings-hmac/1";
/** Exact byte length of the random per-onboarding nonce that keys every settings HMAC. */
export const SETTINGS_HMAC_NONCE_BYTES = 32;
/** NVS namespace whose entries schema 1 digests: upstream ESP-Miner's `NVS_CONFIG_NAMESPACE`. */
export const SETTINGS_SCHEMA_ONE_NAMESPACE = "main";

const MAXIMUM_ENTRIES = 1_024;
const MAXIMUM_STR_BYTES = 3_999;
const MAXIMUM_BLOB_BYTES = 65_536;

/** Redacted setting categories, in the order every verification lists them. */
export const SETTINGS_CATEGORIES = ["all", "network", "pool"] as const;
export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

/** One nonce-keyed category HMAC, as base64url without padding. */
export type SettingsCategoryHmac = { category: SettingsCategory; hmacSha256: string };

/** ESP-IDF `nvs_type_t` names and codes. */
const NVS_TYPE_CODES = {
  u8: 0x01,
  i8: 0x11,
  u16: 0x02,
  i16: 0x12,
  u32: 0x04,
  i32: 0x14,
  u64: 0x08,
  i64: 0x18,
  str: 0x21,
  blob: 0x42,
} as const;
export type NvsType = keyof typeof NVS_TYPE_CODES;
type NvsIntegerType = Exclude<NvsType, "str" | "blob">;

/**
 * One decoded NVS entry from the `main` namespace. Integers are canonical decimal strings,
 * `str` values are the stored text without its terminator, and blobs are base64url.
 */
export type NvsSettingEntry = { key: string; type: NvsType; value: string };

const NETWORK_KEYS = ["wifissid", "wifipass", "hostname", "usentp"] as const;
const POOL_KEYS = [
  ...Array.from({ length: 8 }, (_, index) => `pool_${index + 1}`),
  "prim_idx",
  "sec_idx",
  "usefbstartum",
] as const;
/**
 * Every key in upstream's `main/nvs_config.c` settings table plus its two downgrade fallback
 * keys, except values the firmware itself changes across a reboot or a firmware change:
 * `last_fw_fp`, `use_custom_www`, `bestdiff`, `total_uptime`, `cum_hashes_hi`,
 * `cum_hashes_lo` and `scoreboard_01` to `scoreboard_20`.
 */
const ALL_KEYS = [
  ...NETWORK_KEYS,
  ...POOL_KEYS,
  "asicfrequency_f",
  "asicvoltage",
  "oc_enabled",
  "display",
  "rotation",
  "invertscreen",
  "displayOffset",
  "displayTimeout",
  "autofanspeed",
  "manualfanspeed",
  "minfanspeed",
  "temptarget",
  "overheat_mode",
  "mineonboot",
  "statsFrequency",
  "selftest",
  "swarmconfig",
  "themescheme",
  "themecolor",
  "boardversion",
  "devicemodel",
  "asicmodel",
  "plug_sense",
  "asic_enable",
  "EMC2101",
  "EMC2103",
  "EMC2302",
  "emc_int_temp",
  "emc_ideality_f",
  "emc_beta_comp",
  "temp_offset",
  "DS4432U",
  "INA260",
  "TPS546",
  "TMP1075",
  "power_cons_tgt",
  "selftest_temp",
  "selftest_warm",
  "selftest_max",
  "selftest_fan",
  "tps546_phase",
  "tps546_vin_on",
  "tps546_vin_off",
  "tps546_vin_uvw",
  "tps546_vin_ovf",
  "tps546_scale",
  "tps546_vout_min",
  "tps546_vout_max",
  "tps546_vout_cmd",
  "tps546_oc_warn",
  "tps546_oc_fault",
  "tps546_stack",
  "tps546_sync",
  "tps546_freq",
  "nominal_voltage",
  "asicfrequency",
  "fanspeed",
] as const;

/** Exact NVS keys each settings schema digests per category, in byte-wise ascending order. */
export const SETTINGS_SCHEMA_KEYS: Readonly<
  Record<number, Readonly<Record<SettingsCategory, readonly string[]>>>
> = {
  1: {
    all: sortedKeys(ALL_KEYS),
    network: sortedKeys(NETWORK_KEYS),
    pool: sortedKeys(POOL_KEYS),
  },
};

/** Parses decoded `main` namespace entries, refusing duplicates and values NVS cannot hold. */
export function parseNvsSettingEntries(input: unknown): readonly NvsSettingEntry[] {
  if (!Array.isArray(input) || input.length > MAXIMUM_ENTRIES) {
    throw new Error("NVS settings entries are invalid");
  }
  const entries = input.map(parseEntry);
  const keys = new Set(entries.map((entry) => entry.key));
  if (keys.size !== entries.length) throw new Error("NVS settings entries are invalid");
  return entries;
}

/** Builds the exact bytes one category HMAC covers; exported for shared conformance vectors. */
export function settingsCategoryMessage(
  entries: readonly NvsSettingEntry[],
  settingsSchema: number,
  category: SettingsCategory,
): Uint8Array {
  const keys = schemaKeys(settingsSchema)[category];
  const byKey = new Map(parseNvsSettingEntries(entries).map((entry) => [entry.key, entry]));
  const parts: Uint8Array[] = [
    ascii(SETTINGS_HMAC_PROFILE),
    Uint8Array.of(0),
    uint32BigEndian(settingsSchema),
    ascii(category),
    Uint8Array.of(0),
  ];
  for (const key of keys) {
    const maybeEntry = byKey.get(key);
    if (!maybeEntry) continue;
    const value = valueBytes(maybeEntry);
    parts.push(
      Uint8Array.of(key.length),
      ascii(key),
      Uint8Array.of(NVS_TYPE_CODES[maybeEntry.type]),
      uint32BigEndian(value.byteLength),
      value,
    );
  }
  return concatenate(parts);
}

/** Computes every category's HMAC-SHA-256 under one random per-onboarding nonce. */
export async function settingsCategoryHmacs(
  entries: readonly NvsSettingEntry[],
  settingsSchema: number,
  nonce: Uint8Array,
): Promise<readonly SettingsCategoryHmac[]> {
  if (nonce.byteLength !== SETTINGS_HMAC_NONCE_BYTES) {
    throw new Error("settings HMAC nonce is invalid");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    nonce.slice().buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const hmacs: SettingsCategoryHmac[] = [];
  for (const category of SETTINGS_CATEGORIES) {
    const message = settingsCategoryMessage(entries, settingsSchema, category);
    const mac = await crypto.subtle.sign("HMAC", key, message.slice().buffer);
    hmacs.push({ category, hmacSha256: encodeBase64Url(new Uint8Array(mac)) });
  }
  return hmacs;
}

/** Returns a fresh random settings HMAC nonce. */
export function randomSettingsNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SETTINGS_HMAC_NONCE_BYTES));
}

function schemaKeys(settingsSchema: number): Readonly<Record<SettingsCategory, readonly string[]>> {
  const maybeKeys = SETTINGS_SCHEMA_KEYS[settingsSchema];
  if (!maybeKeys) throw new Error("settings schema cannot be safely preserved");
  return maybeKeys;
}

function parseEntry(input: unknown): NvsSettingEntry {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("NVS settings entries are invalid");
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 3 ||
    !keys.includes("key") ||
    !keys.includes("type") ||
    !keys.includes("value") ||
    typeof record.key !== "string" ||
    !/^[!-~]{1,15}$/u.test(record.key) ||
    typeof record.type !== "string" ||
    !Object.hasOwn(NVS_TYPE_CODES, record.type) ||
    typeof record.value !== "string"
  ) {
    throw new Error("NVS settings entries are invalid");
  }
  const entry = { key: record.key, type: record.type as NvsType, value: record.value };
  valueBytes(entry);
  return entry;
}

function valueBytes(entry: NvsSettingEntry): Uint8Array {
  if (entry.type === "str") return strBytes(entry.value);
  if (entry.type === "blob") return blobBytes(entry.value);
  return integerBytes(entry.type, entry.value);
}

function strBytes(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  if (value.includes("\u0000") || bytes.byteLength > MAXIMUM_STR_BYTES) {
    throw new Error("NVS settings entries are invalid");
  }
  return bytes;
}

function blobBytes(value: string): Uint8Array {
  if (value === "") return new Uint8Array();
  const bytes = decodeBase64Url(
    value,
    Math.ceil((MAXIMUM_BLOB_BYTES * 4) / 3),
    "NVS settings entries are invalid",
  );
  if (encodeBase64Url(bytes) !== value) throw new Error("NVS settings entries are invalid");
  return bytes;
}

const INTEGER_LAYOUT: Readonly<Record<NvsIntegerType, { bytes: number; signed: boolean }>> = {
  u8: { bytes: 1, signed: false },
  i8: { bytes: 1, signed: true },
  u16: { bytes: 2, signed: false },
  i16: { bytes: 2, signed: true },
  u32: { bytes: 4, signed: false },
  i32: { bytes: 4, signed: true },
  u64: { bytes: 8, signed: false },
  i64: { bytes: 8, signed: true },
};

/** Encodes an integer little-endian at its NVS width, exactly as NVS stores it. */
function integerBytes(type: NvsIntegerType, value: string): Uint8Array {
  if (!/^(0|-?[1-9][0-9]{0,19})$/u.test(value)) {
    throw new Error("NVS settings entries are invalid");
  }
  const layout = INTEGER_LAYOUT[type];
  const bits = BigInt(layout.bytes * 8);
  const parsed = BigInt(value);
  const minimum = layout.signed ? -(1n << (bits - 1n)) : 0n;
  const maximum = layout.signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
  if (parsed < minimum || parsed > maximum) {
    throw new Error("NVS settings entries are invalid");
  }
  let unsigned = BigInt.asUintN(Number(bits), parsed);
  const bytes = new Uint8Array(layout.bytes);
  for (let index = 0; index < layout.bytes; index += 1) {
    bytes[index] = Number(unsigned & 0xffn);
    unsigned >>= 8n;
  }
  return bytes;
}

function sortedKeys(keys: readonly string[]): readonly string[] {
  return [...keys].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function ascii(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function uint32BigEndian(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}
