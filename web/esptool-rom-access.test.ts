import { afterEach, expect, mock, test } from "bun:test";
import { baseMacAdmission } from "./bitaxe-base-mac-admission";
import { md5 } from "./esp-flash-digests";

// A stand-in for esptool-js: the chip reports MAC_ONE, every flash write is recorded, and the
// stub's read-flash exchange is played back: data packets of the requested size, then an MD5.
const MAC_ONE = "02:00:00:00:a1:b1";
const MAC_ONE_DIGEST = "3c83711e28525fd6217b2645fa72a3043ecbb2952d4de81bc0a8d0b0342d733d";
const MAC_TWO_DIGEST = "a7780c44e643e7659b14ab8227f71c3bb4577fd03a47f180d63243e47148db7f";
const ESP_READ_FLASH = 0xd2;
const flash = Uint8Array.from({ length: 0x2000 }, (_, index) => (index * 7) % 256);
type ReadFault = "none" | "status" | "wrong_digest" | "overrun";
const board = {
  writes: 0,
  disconnects: 0,
  readFault: "none" as ReadFault,
  readRequests: [] as Array<{ offset: number; length: number; packetBytes: number; inFlight: number }>,
  acknowledgements: [] as number[],
  replies: [] as Uint8Array[],
};
const word = (bytes: Uint8Array, at: number) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(at, true);
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
    async read() {
      const reply = board.replies.shift();
      if (!reply) throw new Error("No serial data received.");
      return reply;
    }
    async write(data: Uint8Array) {
      board.acknowledgements.push(word(data, 0));
    }
  },
  ESPLoader: class {
    readonly chip = { readMac: async () => MAC_ONE };
    readonly ESP_READ_FLASH = ESP_READ_FLASH;
    async main() {
      return "ESP32-S3";
    }
    async writeFlash() {
      board.writes += 1;
    }
    async checkCommand(_description: string, op: number, data: Uint8Array) {
      if (op !== ESP_READ_FLASH) throw new Error("unexpected command");
      const request = { offset: word(data, 0), length: word(data, 4), packetBytes: word(data, 8), inFlight: word(data, 12) };
      board.readRequests.push(request);
      if (board.readFault === "status") return 1;
      const bytes = flash.slice(request.offset, request.offset + request.length);
      for (let at = 0; at < bytes.length; at += request.packetBytes) {
        board.replies.push(bytes.slice(at, at + request.packetBytes));
      }
      if (board.readFault === "overrun") board.replies.push(new Uint8Array(request.packetBytes));
      const digest = md5(bytes);
      if (board.readFault === "wrong_digest") digest[0] = (digest[0] ?? 0) ^ 0xff;
      board.replies.push(digest);
      return 0;
    }
  },
}));
const { esptoolRomAccess } = await import("./esptool-rom-access");

afterEach(() => {
  board.writes = 0;
  board.disconnects = 0;
  board.readFault = "none";
  board.readRequests = [];
  board.acknowledgements = [];
  board.replies = [];
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

test("reads flash in 256-byte packets, one in flight, acknowledging each", async () => {
  // Arrange
  const session = await romAccess(MAC_ONE_DIGEST).access.enter();

  // Act
  const read = await session.readFlash(0x1000, 0x300);

  // Assert
  expect(read).toEqual(flash.slice(0x1000, 0x1300));
  expect(board.readRequests).toEqual([{ offset: 0x1000, length: 0x300, packetBytes: 256, inFlight: 1 }]);
  expect(board.acknowledgements).toEqual([256, 512, 768]);
});

test("consumes the stub's digest, so the next read starts clean", async () => {
  // Arrange
  const session = await romAccess(MAC_ONE_DIGEST).access.enter();
  await session.readFlash(0, 0x100);

  // Act
  const next = await session.readFlash(0x100, 0x100);

  // Assert
  expect(next).toEqual(flash.slice(0x100, 0x200));
  expect(board.replies).toEqual([]);
});

test("refuses a read whose digest doesn't match the bytes", async () => {
  // Arrange
  const session = await romAccess(MAC_ONE_DIGEST).access.enter();
  board.readFault = "wrong_digest";

  // Act
  const read = session.readFlash(0, 0x200);

  // Assert
  await expect(read).rejects.toThrow("flash read digest");
});

test("refuses a read the stub won't start", async () => {
  // Arrange
  const session = await romAccess(MAC_ONE_DIGEST).access.enter();
  board.readFault = "status";

  // Act
  const read = session.readFlash(0, 0x100);

  // Assert
  await expect(read).rejects.toThrow("flash read");
});

test("refuses more data than was asked for", async () => {
  // Arrange
  const session = await romAccess(MAC_ONE_DIGEST).access.enter();
  board.readFault = "overrun";

  // Act
  const read = session.readFlash(0, 0x100);

  // Assert
  await expect(read).rejects.toThrow("flash read");
});
