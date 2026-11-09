#!/usr/bin/env node
// Regenerates conformance/bwg-bitaxe-onboarding-0.2/settings-hmac-vectors.json.
// This is a second, independent implementation of the settings HMAC encoding: it uses
// node:crypto and imports nothing from web/, so the TypeScript module is checked against it.
// Run: node scripts/generate-bitaxe-settings-hmac-vectors.mjs
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const output = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "conformance",
  "bwg-bitaxe-onboarding-0.2",
  "settings-hmac-vectors.json",
);

const TYPE_CODES = {
  u8: [0x01, 1, false],
  i8: [0x11, 1, true],
  u16: [0x02, 2, false],
  i16: [0x12, 2, true],
  u32: [0x04, 4, false],
  i32: [0x14, 4, true],
  u64: [0x08, 8, false],
  i64: [0x18, 8, true],
  str: [0x21],
  blob: [0x42],
};

const network = ["wifissid", "wifipass", "hostname", "usentp"];
const pool = [1, 2, 3, 4, 5, 6, 7, 8].map((index) => `pool_${index}`).concat([
  "prim_idx",
  "sec_idx",
  "usefbstartum",
]);
const rest = (
  "asicfrequency_f asicvoltage oc_enabled display rotation invertscreen displayOffset " +
  "displayTimeout autofanspeed manualfanspeed minfanspeed temptarget overheat_mode mineonboot " +
  "statsFrequency selftest swarmconfig themescheme themecolor boardversion devicemodel " +
  "asicmodel plug_sense asic_enable EMC2101 EMC2103 EMC2302 emc_int_temp emc_ideality_f " +
  "emc_beta_comp temp_offset DS4432U INA260 TPS546 TMP1075 power_cons_tgt selftest_temp " +
  "selftest_warm selftest_max selftest_fan tps546_phase tps546_vin_on tps546_vin_off " +
  "tps546_vin_uvw tps546_vin_ovf tps546_scale tps546_vout_min tps546_vout_max " +
  "tps546_vout_cmd tps546_oc_warn tps546_oc_fault tps546_stack tps546_sync tps546_freq " +
  "nominal_voltage asicfrequency fanspeed"
).split(" ");
const byteOrder = (keys) => [...keys].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
const schemaOne = {
  namespace: "main",
  categories: {
    all: byteOrder([...network, ...pool, ...rest]),
    network: byteOrder(network),
    pool: byteOrder(pool),
  },
};

function valueBytes({ type, value }) {
  if (type === "str") return Buffer.from(value, "utf8");
  if (type === "blob") return Buffer.from(value, "base64url");
  const [, width, signed] = TYPE_CODES[type];
  const buffer = Buffer.alloc(8);
  if (signed) buffer.writeBigInt64LE(BigInt(value));
  else buffer.writeBigUInt64LE(BigInt(value));
  return buffer.subarray(0, width);
}

function message(entries, schema, category) {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const schemaBytes = Buffer.alloc(4);
  schemaBytes.writeUInt32BE(schema);
  const parts = [Buffer.from("bwg-settings-hmac/1\0"), schemaBytes, Buffer.from(`${category}\0`)];
  for (const key of schemaOne.categories[category]) {
    const entry = byKey.get(key);
    if (!entry) continue;
    const value = valueBytes(entry);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(value.length);
    parts.push(Buffer.from([key.length]), Buffer.from(key), Buffer.from([TYPE_CODES[entry.type][0]]));
    parts.push(length, value);
  }
  return Buffer.concat(parts);
}

function vector(name, description, nonceHex, entries) {
  const nonce = Buffer.from(nonceHex, "hex");
  return {
    name,
    description,
    settingsSchema: 1,
    nonce: nonce.toString("base64url"),
    entries,
    categories: ["all", "network", "pool"].map((category) => {
      const bytes = message(entries, 1, category);
      return {
        category,
        messageHex: bytes.toString("hex"),
        hmacSha256: createHmac("sha256", nonce).update(bytes).digest("base64url"),
      };
    }),
  };
}

const countingNonce = Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString("hex");
const stockSettings = [
  { key: "wifissid", type: "str", value: "example-network" },
  { key: "wifipass", type: "str", value: "example-passphrase" },
  { key: "hostname", type: "str", value: "bitaxe" },
  { key: "usentp", type: "u16", value: "0" },
  {
    key: "pool_1",
    type: "str",
    value: '{"url":"pool.example","port":3333,"user":"worker.example","pass":"x"}',
  },
  { key: "prim_idx", type: "u16", value: "0" },
  { key: "sec_idx", type: "u16", value: "1" },
  { key: "asicfrequency_f", type: "str", value: "525.000000" },
  { key: "asicvoltage", type: "u16", value: "1150" },
  { key: "displayTimeout", type: "i32", value: "-1" },
  { key: "EMC2101", type: "u16", value: "1" },
  { key: "temp_offset", type: "i32", value: "-5" },
  { key: "bestdiff", type: "u64", value: "18446744073709551615" },
  { key: "total_uptime", type: "u64", value: "123456" },
  { key: "last_fw_fp", type: "str", value: "v2.13.0_Jan 01 2026_00:00:00" },
  { key: "use_custom_www", type: "u16", value: "1" },
  { key: "unlisted", type: "blob", value: "AAEC_w" },
];

function verificationReplies(stock, otherNonce) {
  const reply = {
    preservationConfirmed: true,
    runningFirmwareVersion: "2.13.0",
    settingsSchemaVersion: 1,
    activeSlot: "ota_0",
    bootable: true,
    nonce: stock.nonce,
    categories: stock.categories.map(({ category, hmacSha256 }) => ({ category, hmacSha256 })),
  };
  const plainSha256 = stock.categories.map(({ category, messageHex }) => ({
    category,
    digestSha256: createHash("sha256").update(Buffer.from(messageHex, "hex")).digest("base64url"),
  }));
  return {
    expectedNonce: stock.nonce,
    accepted: [{ name: "stock-settings-on-ota_0", reply }],
    refused: [
      { name: "plain-sha256-digests", reply: { ...reply, categories: plainSha256 } },
      {
        name: "reply-under-another-nonce",
        reply: { ...reply, nonce: otherNonce.nonce, categories: otherNonce.categories.map(
          ({ category, hmacSha256 }) => ({ category, hmacSha256 }),
        ) },
      },
      { name: "device-reported-rollback-state", reply: { ...reply, rollbackState: "available" } },
      { name: "missing-nonce", reply: { ...reply, nonce: undefined } },
      { name: "categories-out-of-order", reply: { ...reply, categories: [...reply.categories].reverse() } },
    ],
  };
}

const vectors = {
  profile: "bwg-settings-hmac/1",
  description:
    "Settings-schema key lists and nonce-keyed category HMACs for Bitaxe onboarding. " +
    "Generated by scripts/generate-bitaxe-settings-hmac-vectors.mjs; see " +
    "docs/protocol/bwg-0.1-bitaxe-onboarding.md for the encoding.",
  schemas: { 1: schemaOne },
  vectors: [
    vector(
      "empty-nvs",
      "No `main` entries: each message is the header alone.",
      "ff".repeat(32),
      [],
    ),
    vector(
      "stock-settings",
      "Upstream-shaped entries, including keys schema 1 ignores (counters, the firmware " +
        "fingerprint, custom WWW and an unlisted blob).",
      countingNonce,
      stockSettings,
    ),
    vector(
      "stock-settings-counters-changed",
      "As stock-settings with every ignored key changed: all three HMACs are unchanged.",
      countingNonce,
      stockSettings.map((entry) =>
        ["bestdiff", "total_uptime", "last_fw_fp", "use_custom_www"].includes(entry.key)
          ? { ...entry, value: entry.type === "str" ? "v2.14.0_Feb 02 2026_00:00:00" : "0" }
          : entry,
      ),
    ),
    vector(
      "stock-settings-wifi-changed",
      "As stock-settings with `wifipass` changed: `all` and `network` change, `pool` does not.",
      countingNonce,
      stockSettings.map((entry) =>
        entry.key === "wifipass" ? { ...entry, value: "another-passphrase" } : entry,
      ),
    ),
    vector(
      "stock-settings-other-nonce",
      "As stock-settings under another nonce: every HMAC changes.",
      "a5".repeat(32),
      stockSettings,
    ),
  ],
  refusedEntries: [
    ["duplicate-key", [stockSettings[0], { ...stockSettings[0], value: "again" }]],
    ["key-longer-than-15", [{ key: "abcdefghijklmnop", type: "u16", value: "1" }]],
    ["str-with-nul", [{ key: "wifissid", type: "str", value: "a\u0000b" }]],
    ["u16-out-of-range", [{ key: "usentp", type: "u16", value: "65536" }]],
    ["i32-out-of-range", [{ key: "temp_offset", type: "i32", value: "-2147483649" }]],
    ["non-canonical-integer", [{ key: "prim_idx", type: "u16", value: "01" }]],
    ["unknown-type", [{ key: "asicfrequency_f", type: "float", value: "525" }]],
    ["non-canonical-blob", [{ key: "unlisted", type: "blob", value: "AAEC_x" }]],
    ["extra-field", [{ key: "usentp", type: "u16", value: "0", namespace: "main" }]],
  ].map(([name, entries]) => ({ name, entries })),
};

vectors.verificationReplies = verificationReplies(vectors.vectors[1], vectors.vectors[4]);

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(vectors, null, 2)}\n`);
console.log(`wrote ${vectors.vectors.length} vectors to ${output}`);
