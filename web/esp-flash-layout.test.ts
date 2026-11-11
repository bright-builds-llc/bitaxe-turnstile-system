import { describe, expect, test } from "bun:test";
import vector from "../conformance/bwg-bitaxe-onboarding-0.2/nvs-partition-vector.json";
import { espCrc32Le, md5Hex } from "./esp-flash-digests";
import { maybeAppDescriptor, semanticFirmwareVersion } from "./esp-app-image";
import { parseNvsPartition } from "./esp-nvs";
import { OTA_IMAGE_STATE, OTADATA_BYTES, otadataBooting, selectedBootSlot } from "./esp-otadata";
import {
  classifyPartitionTable,
  encodePartitionTable,
  KNOWN_PARTITION_TABLES,
} from "./esp-partition-table";
import { parseNvsSettingEntries } from "./bitaxe-settings-hmac";
import { appImage, flipBits, vectorNvsPartition } from "./rom-onboarding.test-support";

/** `build/partition_table/partition-table.bin` of bitaxe-esp-miner-c `51e5af9`, before its `0xFF` fill. */
const C_TABLE_FROM_GEN_ESP32PART =
  "aa50010200900000006000006e76730000000000000000000000000000000000" +
  "aa50010100f00000001000007068795f696e6974000000000000000000000000" +
  "aa5000000000010000004000666163746f727900000000000000000000000000" +
  "aa50018200004100000030007777770000000000000000000000000000000000" +
  "aa50001000007100000040006f74615f30000000000000000000000000000000" +
  "aa5000110000b100000040006f74615f31000000000000000000000000000000" +
  "aa5001000000f100002000006f74616461746100000000000000000000000000" +
  "aa5001030020f10000e00e00636f726564756d70000000000000000000000000" +
  "ebebffffffffffffffffffffffffffff3263d40fec2a495265671ec0d6d91d45";

const text = (value: string) => new TextEncoder().encode(value);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("flash digests", () => {
  test("MD5 matches RFC 1321's vectors", () => {
    expect(md5Hex(text(""))).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex(text("abc"))).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5Hex(text("1234567890".repeat(8)))).toBe("57edf4a22be3c955ac49da2e2107b67a");
  });

  test("the ROM CRC of an otadata sequence matches otatool's binascii.crc32(seq, 0xFFFFFFFF)", () => {
    expect(espCrc32Le(0xffff_ffff, new Uint8Array([1, 0, 0, 0]))).toBe(0x4743989a);
    expect(espCrc32Le(0xffff_ffff, new Uint8Array([2, 0, 0, 0]))).toBe(0x55f63774);
  });
});

describe("partition table", () => {
  test("encodes the C table byte for byte as gen_esp32part.py built it", () => {
    expect(hex(encodePartitionTable(KNOWN_PARTITION_TABLES.c)).replace(/(ff)+$/u, "")).toBe(
      C_TABLE_FROM_GEN_ESP32PART,
    );
  });

  test("names upstream's table and the C table", () => {
    expect(classifyPartitionTable(encodePartitionTable(KNOWN_PARTITION_TABLES.upstream))).toBe("upstream");
    expect(classifyPartitionTable(encodePartitionTable(KNOWN_PARTITION_TABLES.c))).toBe("c");
  });

  test("refuses a table with any row changed", () => {
    const table = KNOWN_PARTITION_TABLES.c.map((entry) =>
      entry.label === "ota_1" ? { ...entry, offset: entry.offset + 0x1000 } : entry,
    );
    expect(() => classifyPartitionTable(encodePartitionTable(table))).toThrow("neither upstream's");
  });

  test("refuses a known table whose MD5 row is wrong", () => {
    const region = encodePartitionTable(KNOWN_PARTITION_TABLES.c);
    flipBits(region, 8 * 32 + 20);
    expect(() => classifyPartitionTable(region)).toThrow("MD5 row is invalid");
  });

  test("refuses bytes after the MD5 row", () => {
    const region = encodePartitionTable(KNOWN_PARTITION_TABLES.upstream);
    region[0xbff] = 0x00;
    expect(() => classifyPartitionTable(region)).toThrow("MD5 row is invalid");
  });

  test("refuses an erased region", () => {
    expect(() => classifyPartitionTable(new Uint8Array(0xc00).fill(0xff))).toThrow("no MD5 row");
  });
});

describe("otadata", () => {
  const erased = () => new Uint8Array(OTADATA_BYTES).fill(0xff);

  test("boots factory when no entry is valid", () => {
    expect(selectedBootSlot(erased())).toEqual({ slot: "factory" });
  });

  test("an install from factory writes sequence 1 for ota_0 in sector 0 as NEW", () => {
    // Act
    const otadata = otadataBooting(erased(), "ota_0", OTA_IMAGE_STATE.new);

    // Assert
    expect(hex(otadata.subarray(0, 32))).toBe(`01000000${"ff".repeat(20)}000000009a984347`);
    expect(otadata.subarray(0x1000).every((byte) => byte === 0xff)).toBe(true);
  });

  test("an install from ota_0 writes the next sequence for ota_1 in the other sector", () => {
    // Arrange
    const onOta0 = otadataBooting(erased(), "ota_0", OTA_IMAGE_STATE.valid);

    // Act
    const otadata = otadataBooting(onOta0, "ota_1", OTA_IMAGE_STATE.new);

    // Assert
    expect(selectedBootSlot(otadata)).toEqual({ slot: "ota_1", state: OTA_IMAGE_STATE.new, sector: 1 });
    expect(otadata.subarray(0, 32)).toEqual(onOta0.subarray(0, 32));
  });

  test("a rollback to ota_0 from ota_1 takes sequence 3 in sector 0, valid", () => {
    // Arrange
    const onOta1 = otadataBooting(
      otadataBooting(erased(), "ota_0", OTA_IMAGE_STATE.valid),
      "ota_1",
      OTA_IMAGE_STATE.valid,
    );

    // Act
    const otadata = otadataBooting(onOta1, "ota_0", OTA_IMAGE_STATE.valid);

    // Assert
    expect(new DataView(otadata.buffer).getUint32(0, true)).toBe(3);
    expect(selectedBootSlot(otadata)).toEqual({ slot: "ota_0", state: OTA_IMAGE_STATE.valid, sector: 0 });
  });

  test("a rollback to factory erases both sectors", () => {
    const onOta0 = otadataBooting(erased(), "ota_0", OTA_IMAGE_STATE.valid);
    expect(otadataBooting(onOta0, "factory", OTA_IMAGE_STATE.valid)).toEqual(erased());
  });

  test("an aborted or corrupt entry is passed over, as the bootloader does", () => {
    // Arrange
    const otadata = otadataBooting(
      otadataBooting(erased(), "ota_0", OTA_IMAGE_STATE.valid),
      "ota_1",
      OTA_IMAGE_STATE.aborted,
    );
    const corrupt = otadataBooting(erased(), "ota_1", OTA_IMAGE_STATE.valid);
    flipBits(corrupt, 28);

    // Act / Assert
    expect(selectedBootSlot(otadata).slot).toBe("ota_0");
    expect(selectedBootSlot(corrupt).slot).toBe("factory");
  });
});

describe("NVS partition", () => {
  test("decodes the main namespace of ESP-IDF's own generator output", () => {
    expect(parseNvsPartition(vectorNvsPartition())).toEqual(parseNvsSettingEntries(vector.expectedMainEntries));
  });

  test("refuses a string whose data CRC is wrong", () => {
    // Arrange
    const partition = vectorNvsPartition();
    const at = Buffer.from(partition).indexOf("fixture-network");
    flipBits(partition, at);

    // Act / Assert
    expect(() => parseNvsPartition(partition)).toThrow("value data is corrupt");
  });

  test("refuses a page whose header CRC is wrong", () => {
    const partition = vectorNvsPartition();
    flipBits(partition, 8);
    expect(() => parseNvsPartition(partition)).toThrow("page header is corrupt");
  });

  test("passes over an erased entry, as the firmware's NVS does", () => {
    // Arrange
    const partition = vectorNvsPartition();
    const states = partition.subarray(32, 64);
    const hostnameIndex = entryIndexOf(partition, "hostname");
    flipBits(states, Math.floor(hostnameIndex / 4), 0b10 << ((hostnameIndex % 4) * 2));

    // Act
    const keys = parseNvsPartition(partition).map((entry) => entry.key);

    // Assert
    expect(keys).not.toContain("hostname");
    expect(keys).toContain("wifissid");
  });
});

describe("app image", () => {
  test("reads the project name and version of an image", () => {
    expect(maybeAppDescriptor(appImage("esp-miner", "v2.10.1"))).toEqual({
      projectName: "esp-miner",
      version: "v2.10.1",
    });
  });

  test("reports no image in an erased slot", () => {
    expect(maybeAppDescriptor(new Uint8Array(0x100).fill(0xff))).toBeUndefined();
  });

  test("carries a release version without its v and refuses a describe suffix", () => {
    expect(semanticFirmwareVersion("v2.10.1")).toBe("2.10.1");
    expect(() => semanticFirmwareVersion("v2.10.1-dirty")).toThrow("not a release version");
  });
});

function entryIndexOf(partition: Uint8Array, key: string): number {
  for (let index = 0; index < 126; index += 1) {
    const at = 64 + index * 32;
    if (Buffer.from(partition.subarray(at + 8, at + 8 + key.length)).toString() === key && partition[at + 8 + key.length] === 0) {
      return index;
    }
  }
  throw new Error(`no entry for ${key}`);
}
