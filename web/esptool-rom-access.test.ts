import { afterEach, expect, mock, test } from "bun:test";
import { baseMacAdmission } from "./bitaxe-base-mac-admission";

// A stand-in for esptool-js: the chip reports MAC_ONE, and every flash write is recorded.
const MAC_ONE = "02:00:00:00:a1:b1";
const MAC_ONE_DIGEST = "3c83711e28525fd6217b2645fa72a3043ecbb2952d4de81bc0a8d0b0342d733d";
const MAC_TWO_DIGEST = "a7780c44e643e7659b14ab8227f71c3bb4577fd03a47f180d63243e47148db7f";
const board = { writes: 0, disconnects: 0 };
mock.module("esptool-js", () => ({
  Transport: class {
    readonly device: { readable: object | null };
    constructor(port: { readable: object | null }) {
      this.device = port;
    }
    async disconnect() {
      board.disconnects += 1;
      this.device.readable = null;
    }
  },
  ESPLoader: class {
    readonly chip = { readMac: async () => MAC_ONE };
    async main() {
      return "ESP32-S3";
    }
    async writeFlash() {
      board.writes += 1;
    }
  },
}));
const { esptoolRomAccess } = await import("./esptool-rom-access");

afterEach(() => {
  board.writes = 0;
  board.disconnects = 0;
});

function romAccess(expectedDigest: string) {
  const lock = { held: false };
  const access = esptoolRomAccess({
    port: async () => ({ readable: {}, writable: {} }) as never,
    acquireLock: async () => {
      lock.held = true;
      return () => {
        lock.held = false;
      };
    },
    maybeAdmitBaseMac: baseMacAdmission(expectedDigest),
  });
  return { access, lock };
}

test("refuses another board's MAC on ROM entry, before any session can write", async () => {
  // Arrange
  const { access, lock } = romAccess(MAC_TWO_DIGEST);

  // Act
  const entry = access.enter();

  // Assert
  await expect(entry).rejects.toThrow("the board's base MAC is not the expected board's");
  expect({ writes: board.writes, disconnects: board.disconnects, lockHeld: lock.held }).toEqual({
    writes: 0,
    disconnects: 1,
    lockHeld: false,
  });
});

test("opens a session for the expected board's MAC", async () => {
  // Arrange
  const { access, lock } = romAccess(MAC_ONE_DIGEST);

  // Act
  const session = await access.enter();
  await session.writeFlash(0x10000, new Uint8Array([1]));

  // Assert
  expect({ writes: board.writes, lockHeld: lock.held }).toEqual({ writes: 1, lockHeld: true });
});
