import { describe, expect, test } from "bun:test";

import vectors from "../conformance/bwg-bitaxe-onboarding-0.2/settings-hmac-vectors.json";
import {
  parseNvsSettingEntries,
  SETTINGS_HMAC_PROFILE,
  SETTINGS_SCHEMA_KEYS,
  settingsCategoryHmacs,
  settingsCategoryMessage,
  type NvsSettingEntry,
} from "./bitaxe-settings-hmac";

const stock = vectors.vectors.find((vector) => vector.name === "stock-settings");

describe("settings schema 1", () => {
  test("names the same category keys as the shared vectors", () => {
    // Arrange
    const expected = vectors.schemas["1"].categories;

    // Act
    const actual = SETTINGS_SCHEMA_KEYS[1];

    // Assert
    expect(actual).toEqual(expected);
  });

  test("puts every network and pool key in the all category", () => {
    // Arrange
    const keys = SETTINGS_SCHEMA_KEYS[1];

    // Act
    const missing = [...(keys?.network ?? []), ...(keys?.pool ?? [])].filter(
      (key) => !keys?.all.includes(key),
    );

    // Assert
    expect(missing).toEqual([]);
  });

  test("leaves out values the firmware changes across a reboot or firmware change", () => {
    // Arrange
    const volatile = ["last_fw_fp", "use_custom_www", "bestdiff", "total_uptime", "scoreboard_01"];

    // Act
    const included = volatile.filter((key) => SETTINGS_SCHEMA_KEYS[1]?.all.includes(key));

    // Assert
    expect(included).toEqual([]);
  });

  test("refuses a schema it does not name", () => {
    // Arrange
    const entries: NvsSettingEntry[] = [];

    // Act
    const build = () => settingsCategoryMessage(entries, 2, "all");

    // Assert
    expect(build).toThrow("settings schema cannot be safely preserved");
  });
});

describe("settings HMAC vectors", () => {
  test("shares the profile the vectors declare", () => {
    // Arrange
    const declared = vectors.profile;

    // Act
    const profile = SETTINGS_HMAC_PROFILE;

    // Assert
    expect(profile).toBe(declared);
  });

  test.each(vectors.vectors.map((vector) => [vector.name, vector] as const))(
    "builds the exact messages of %s",
    (_name, vector) => {
      // Arrange
      const entries = parseNvsSettingEntries(vector.entries);

      // Act
      const messages = vector.categories.map((item) =>
        Buffer.from(
          settingsCategoryMessage(entries, vector.settingsSchema, item.category as "all"),
        ).toString("hex"),
      );

      // Assert
      expect(messages).toEqual(vector.categories.map((item) => item.messageHex));
    },
  );

  test.each(vectors.vectors.map((vector) => [vector.name, vector] as const))(
    "computes the nonce-keyed HMACs of %s",
    async (_name, vector) => {
      // Arrange
      const entries = parseNvsSettingEntries(vector.entries);
      const nonce = new Uint8Array(Buffer.from(vector.nonce, "base64url"));

      // Act
      const hmacs = await settingsCategoryHmacs(entries, vector.settingsSchema, nonce);

      // Assert
      expect<unknown>(hmacs).toEqual(
        vector.categories.map(({ category, hmacSha256 }) => ({ category, hmacSha256 })),
      );
    },
  );

  test("keeps every HMAC when only ignored keys change", () => {
    // Arrange
    const changed = vectors.vectors.find(
      (vector) => vector.name === "stock-settings-counters-changed",
    );

    // Act
    const hmacs = changed?.categories.map((item) => item.hmacSha256);

    // Assert
    expect(hmacs).toEqual(stock?.categories.map((item) => item.hmacSha256));
  });

  test("refuses a nonce that is not 32 bytes", async () => {
    // Arrange
    const shortNonce = new Uint8Array(16);

    // Act
    const compute = settingsCategoryHmacs([], 1, shortNonce);

    // Assert
    await expect(compute).rejects.toThrow("settings HMAC nonce is invalid");
  });
});

describe("NVS settings entries", () => {
  test.each(vectors.refusedEntries.map((vector) => [vector.name, vector.entries] as const))(
    "refuses %s",
    (_name, entries) => {
      // Arrange
      const input: unknown = entries;

      // Act
      const parse = () => parseNvsSettingEntries(input);

      // Assert
      expect(parse).toThrow("NVS settings entries are invalid");
    },
  );

  test("accepts the extreme values each integer width holds", () => {
    // Arrange
    const extremes = [
      { key: "a", type: "u64", value: "18446744073709551615" },
      { key: "b", type: "i64", value: "-9223372036854775808" },
      { key: "c", type: "i8", value: "-128" },
      { key: "d", type: "u8", value: "255" },
    ];

    // Act
    const entries = parseNvsSettingEntries(extremes);

    // Assert
    expect(entries).toHaveLength(4);
  });
});
