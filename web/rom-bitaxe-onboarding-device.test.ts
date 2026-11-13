import { describe, expect, test } from "bun:test";
import { createBitaxeOnboarding, type BitaxeOnboarding } from "./bitaxe-onboarding";
import { bootloader, firmwarePackage, partitionTable } from "./bitaxe-onboarding-test-fixtures";
import { OTA_IMAGE_STATE, selectedBootSlot } from "./esp-otadata";
import { KNOWN_PARTITION_TABLES, partitionLayout, type PartitionEntry } from "./esp-partition-table";
import { RomBitaxeOnboardingDevice } from "./rom-bitaxe-onboarding-device";
import {
  appImage,
  C_IMAGE_PREFIX,
  FakeBoard,
  flipBits,
  instantClock,
  PRE_ONBOARDING_VERSION,
  TEST_BOUNDS,
  vectorNvsPartition,
} from "./rom-onboarding.test-support";
import type { WorkerControllerCapabilities } from "./worker-controller-semantics";

const LAYOUT = partitionLayout("c");
const FIRMWARE_VERSION = "2.0.0";
const C_CAPABILITIES: WorkerControllerCapabilities = {
  protocolVersion: "bwg-worker-controller/0.4",
  board: { model: "bitaxe-gamma", revision: "601", usbTransport: "web_serial" },
  firmware: { name: "bright-builds-reference-firmware", version: FIRMWARE_VERSION },
  compatibility: {
    referenceFirmware: true,
    workLease: "supported",
    miningBaselineRestoration: "supported",
    settingsPreservation: "compatible",
  },
};

async function setUp(table: readonly PartitionEntry[] = KNOWN_PARTITION_TABLES.upstream) {
  const board = new FakeBoard(table);
  // The fake board recognises the C image, which answers Worker Serial, by its prefix.
  const signed = await firmwarePackage(
    { compatibleBoards: [{ model: "bitaxe-gamma", revisions: ["601"] }] },
    new TextEncoder().encode(`${C_IMAGE_PREFIX}-image-v2`),
  );
  const device = new RomBitaxeOnboardingDevice(board.rom(), board.link(C_CAPABILITIES), TEST_BOUNDS, instantClock());
  const onboarding = createBitaxeOnboarding({
    requestDevice: async () => device,
    trustedUpdateKeys: [signed.publicKey],
  });
  return { board, device, onboarding, firmwarePackage: signed.package };
}

describe("RomBitaxeOnboardingDevice from stock", () => {
  test("inspects stock from flash when the image has no Worker Serial", async () => {
    // Arrange
    const { onboarding } = await setUp();

    // Act
    const inspection = await onboarding.connect();

    // Assert
    expect(inspection).toEqual({
      action: "firmware_required",
      capabilities: {
        protocolVersion: "bwg-worker-controller/0.4",
        board: { model: "bitaxe-gamma", revision: "601", usbTransport: "web_serial" },
        firmware: { name: "esp-miner", version: "2.10.1" },
        compatibility: {
          referenceFirmware: false,
          workLease: "supported",
          miningBaselineRestoration: "supported",
          settingsPreservation: "upgrade_required",
        },
      },
      settingsSchemaVersion: 1,
      migrationBackup: "recommended",
    });
  });

  test("writes the image, then the C bootloader and table, then otadata, and never NVS", async () => {
    // Arrange
    const { board, onboarding, firmwarePackage } = await setUp();
    await onboarding.connect();
    board.log.length = 0;

    // Act
    const result = await onboarding.install(firmwarePackage);

    // Assert
    expect(result.status).toBe("ready");
    expect(board.writes()).toEqual(["ota_0", "bootloader", "partition_table", "otadata"]);
  });

  test("reads the bootloader and table back before it touches otadata", async () => {
    // Arrange
    const { board, onboarding, firmwarePackage } = await setUp();
    await onboarding.connect();
    board.log.length = 0;

    // Act
    await onboarding.install(firmwarePackage);

    // Assert
    const order = board.log.map((entry) => ("region" in entry ? `${entry.op}:${entry.region}` : entry.op));
    const firstOtadataWrite = order.indexOf("write:otadata");
    expect(order.slice(0, firstOtadataWrite)).toEqual([
      "enter_rom",
      "read:partition_table",
      "read:nvs",
      "read:partition_table",
      "read:otadata",
      "md5:factory",
      "write:ota_0",
      "md5:ota_0",
      "read:bootloader",
      "write:bootloader",
      "read:bootloader",
      "read:partition_table",
      "write:partition_table",
      "read:partition_table",
      "read:partition_table",
    ]);
    expect(board.region(0x8000, 0xc00)).toEqual(partitionTable);
  });

  test("leaves the image valid on ota_0 once its startup check has passed", async () => {
    // Arrange
    const { board, onboarding, firmwarePackage } = await setUp();
    board.startupInspects = 2;
    await onboarding.connect();

    // Act
    await onboarding.install(firmwarePackage);

    // Assert
    const selection = selectedBootSlot(board.region(LAYOUT.otadata.offset, LAYOUT.otadata.size));
    expect(selection).toEqual({ slot: "ota_0", state: OTA_IMAGE_STATE.valid, sector: 0 });
  });

  test("refuses an unknown partition table before any write", async () => {
    // Arrange
    const moved = KNOWN_PARTITION_TABLES.upstream.map((entry) =>
      entry.label === "www" ? { ...entry, size: 0x200000 } : entry,
    );
    const { board, onboarding, firmwarePackage } = await setUp(moved);

    // Act
    const connecting = onboarding.connect();

    // Assert
    await expect(connecting).rejects.toThrow("neither upstream's nor the C image's");
    await expect(onboarding.install(firmwarePackage)).rejects.toThrow("USB connection is required");
    expect(board.writes()).toEqual([]);
  });

  test("rolls back to factory and restores NVS when the image never comes back", async () => {
    // Arrange
    const { board, onboarding, firmwarePackage } = await setUp();
    await onboarding.connect();
    board.silent = true;
    const original = vectorNvsPartition();

    // Act
    const result = await onboarding.install(firmwarePackage);

    // Assert
    expect(result).toMatchObject({ status: "rolled_back", rollback: "confirmed", firmwareVersion: "2.10.1" });
    expect(selectedBootSlot(board.region(LAYOUT.otadata.offset, LAYOUT.otadata.size)).slot).toBe("factory");
    expect(board.region(LAYOUT.nvs.offset, LAYOUT.nvs.size)).toEqual(original);
  });

  test("checks a rollback to stock from flash, since stock has no Worker Serial", async () => {
    // Arrange
    const { board, onboarding, firmwarePackage } = await setUp();
    await onboarding.connect();
    board.silent = true;

    // Act
    await onboarding.install(firmwarePackage);

    // Assert
    const lastWrite = board.log.map((entry) => entry.op).lastIndexOf("write");
    const afterRollback = board.log.slice(lastWrite);
    expect(afterRollback.map((entry) => entry.op)).toEqual(
      expect.arrayContaining(["reset_to_app", "enter_rom", "read", "reset_to_app"]),
    );
    expect(afterRollback.some((entry) => entry.op === "verify" || entry.op === "inspect")).toBe(false);
  });

  test("falls back to ROM only after the image sent no Hello acknowledgment", async () => {
    // Arrange
    const { board, onboarding } = await setUp();

    // Act
    await onboarding.connect();

    // Assert
    expect(board.log.slice(0, 2)).toEqual([{ op: "connect" }, { op: "enter_rom" }]);
  });
});

describe("RomBitaxeOnboardingDevice between reference images", () => {
  async function cBoardOnOta0() {
    const setup = await setUp(KNOWN_PARTITION_TABLES.c);
    setup.board.flash.set(new TextEncoder().encode(`${C_IMAGE_PREFIX}-image-v1`), LAYOUT.ota_0.offset);
    setup.board.flash.set(validOtadataFor(1), LAYOUT.otadata.offset);
    setup.board.flash.set(bootloader, 0);
    return setup;
  }

  test("inspects the C image over Worker Serial", async () => {
    // Arrange
    const { onboarding } = await cBoardOnOta0();

    // Act
    const inspection = await onboarding.connect();

    // Assert
    expect(inspection.action).toBe("ready");
    expect(inspection.migrationBackup).toBe("optional");
  });

  test("writes only ota_1 and otadata, with the next sequence number", async () => {
    // Arrange
    const { board, onboarding, firmwarePackage } = await cBoardOnOta0();
    await onboarding.connect();
    board.log.length = 0;

    // Act
    const result = await onboarding.install(firmwarePackage);

    // Assert
    expect(result.status).toBe("ready");
    expect(board.writes()).toEqual(["ota_1", "otadata"]);
    expect(selectedBootSlot(board.region(LAYOUT.otadata.offset, LAYOUT.otadata.size))).toEqual({
      slot: "ota_1",
      state: OTA_IMAGE_STATE.valid,
      sector: 1,
    });
  });

  test("rollBack() points otadata at ota_0 and writes the in-memory copy back", async () => {
    // Arrange
    const { board, onboarding, firmwarePackage } = await cBoardOnOta0();
    await onboarding.connect();
    await onboarding.install(firmwarePackage);
    const changed = board.region(LAYOUT.nvs.offset, LAYOUT.nvs.size);
    flipBits(changed, 100, 0xff);
    board.flash.set(changed, LAYOUT.nvs.offset);
    board.log.length = 0;

    // Act
    const result = await rollBack(onboarding);

    // Assert
    expect(result.status).toBe("rolled_back");
    expect(board.writes()).toEqual(["otadata", "nvs"]);
    expect(board.region(LAYOUT.nvs.offset, LAYOUT.nvs.size)).toEqual(vectorNvsPartition());
    expect(selectedBootSlot(board.region(LAYOUT.otadata.offset, LAYOUT.otadata.size)).slot).toBe("ota_0");
  });

  test("stops onboarding when the image answers Hello and then fails possession", async () => {
    // Arrange
    const { board, onboarding } = await cBoardOnOta0();
    board.possessionFails = true;

    // Act
    const connecting = onboarding.connect();

    // Assert
    await expect(connecting).rejects.toThrow("possession_failed");
    expect(board.log).toEqual([{ op: "connect" }]);
  });

  test("stops onboarding when an image with onboarding_inspect answers it with an error", async () => {
    // Arrange
    const { board, onboarding } = await cBoardOnOta0();
    board.inspectFails = true;

    // Act
    const connecting = onboarding.connect();

    // Assert
    await expect(connecting).rejects.toThrow("persistence_failed");
    expect(board.log).toEqual([{ op: "connect" }, { op: "inspect" }, { op: "close" }]);
  });

  test("refuses a changed previous slot before it touches otadata or NVS", async () => {
    // Arrange
    const { board, onboarding, firmwarePackage } = await cBoardOnOta0();
    await onboarding.connect();
    await onboarding.install(firmwarePackage);
    board.flash[LAYOUT.ota_0.offset + 0x1000] = 0x00;
    const changedNvs = board.region(LAYOUT.nvs.offset, LAYOUT.nvs.size);
    flipBits(changedNvs, 100, 0xff);
    board.flash.set(changedNvs, LAYOUT.nvs.offset);
    const otadataBefore = board.region(LAYOUT.otadata.offset, LAYOUT.otadata.size);
    board.log.length = 0;

    // Act
    const rollingBack = rollBack(onboarding);

    // Assert
    await expect(rollingBack).rejects.toThrow("previous slot changed");
    expect(board.writes()).toEqual([]);
    expect(board.region(LAYOUT.otadata.offset, LAYOUT.otadata.size)).toEqual(otadataBefore);
    expect(board.region(LAYOUT.nvs.offset, LAYOUT.nvs.size)).toEqual(changedNvs);
  });

  test("rolls back when the new image reports settings it did not keep", async () => {
    // Arrange
    const { board, onboarding, firmwarePackage } = await cBoardOnOta0();
    await onboarding.connect();
    board.maybeVerifyOverride = (reply) => ({
      ...reply,
      categories: [
        { category: "all", hmacSha256: "A".repeat(43) },
        { category: "network", hmacSha256: "A".repeat(43) },
        { category: "pool", hmacSha256: "A".repeat(43) },
      ],
    });

    // Act
    const result = await onboarding.install(firmwarePackage);

    // Assert
    expect(result.status).toBe("rolled_back");
    expect(selectedBootSlot(board.region(LAYOUT.otadata.offset, LAYOUT.otadata.size)).slot).toBe("ota_0");
  });
});

describe("RomBitaxeOnboardingDevice from a reference image before Ticket 03", () => {
  async function preOnboardingBoard() {
    const setup = await setUp(KNOWN_PARTITION_TABLES.c);
    setup.board.flash.set(appImage("esp-miner", PRE_ONBOARDING_VERSION), LAYOUT.factory.offset);
    return setup;
  }

  test("closes the admitted session and inspects from flash when the image has no onboarding_inspect", async () => {
    // Arrange
    const { board, onboarding } = await preOnboardingBoard();

    // Act
    const inspection = await onboarding.connect();

    // Assert
    expect(inspection).toEqual({
      action: "firmware_required",
      capabilities: {
        ...C_CAPABILITIES,
        compatibility: { ...C_CAPABILITIES.compatibility, settingsPreservation: "upgrade_required" },
      },
      settingsSchemaVersion: 1,
      migrationBackup: "optional",
    });
    expect(board.log.slice(0, 4)).toEqual([
      { op: "connect" },
      { op: "inspect" },
      { op: "close" },
      { op: "enter_rom" },
    ]);
  });

  test("installs the image and the signed C bootloader, then verifies the C image over Worker Serial", async () => {
    // Arrange
    const { board, onboarding, firmwarePackage } = await preOnboardingBoard();
    await onboarding.connect();
    board.log.length = 0;

    // Act
    const result = await onboarding.install(firmwarePackage);

    // Assert
    expect(result.status).toBe("ready");
    expect(board.writes()).toEqual(["ota_0", "bootloader", "otadata"]);
    expect(board.region(0, bootloader.byteLength)).toEqual(bootloader);
    expect(board.log.some((entry) => entry.op === "verify")).toBe(true);
  });

  test("rolls back to the earlier reference image and checks it from flash", async () => {
    // Arrange
    const { board, onboarding, firmwarePackage } = await preOnboardingBoard();
    await onboarding.connect();
    await onboarding.install(firmwarePackage);
    board.log.length = 0;

    // Act
    const result = await rollBack(onboarding);

    // Assert
    expect(result).toMatchObject({ status: "rolled_back", rollback: "confirmed", firmwareVersion: FIRMWARE_VERSION });
    expect(selectedBootSlot(board.region(LAYOUT.otadata.offset, LAYOUT.otadata.size)).slot).toBe("factory");
    expect(board.log.some((entry) => entry.op === "verify" || entry.op === "inspect")).toBe(false);
  });

  test("stops onboarding and writes nothing when the image fails possession", async () => {
    // Arrange
    const { board, onboarding } = await preOnboardingBoard();
    board.possessionFails = true;

    // Act
    const connecting = onboarding.connect();

    // Assert
    await expect(connecting).rejects.toThrow("possession_failed");
    expect(board.log).toEqual([{ op: "connect" }]);
    expect(board.writes()).toEqual([]);
  });
});

test("an app descriptor without a release version is refused before any write", async () => {
  // Arrange
  const { board, onboarding } = await setUp();
  board.flash.set(appImage("esp-miner", "v2.10.1-4-gdeadbee"), LAYOUT.factory.offset);

  // Act
  const connecting = onboarding.connect();

  // Assert
  await expect(connecting).rejects.toThrow("not a release version");
  expect(board.writes()).toEqual([]);
});

function rollBack(onboarding: BitaxeOnboarding) {
  return onboarding.rollBack();
}

function validOtadataFor(seq: number): Uint8Array {
  const otadata = new Uint8Array(LAYOUT.otadata.size).fill(0xff);
  const view = new DataView(otadata.buffer);
  view.setUint32(0, seq, true);
  view.setUint32(24, OTA_IMAGE_STATE.valid, true);
  view.setUint32(28, seq === 1 ? 0x4743989a : 0x55f63774, true);
  return otadata;
}
