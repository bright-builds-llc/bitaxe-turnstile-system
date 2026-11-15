import { ESPLoader, Transport } from "esptool-js";
import { md5 } from "./esp-flash-digests";
import type { WorkerSerialPort } from "./webserial-worker-port";
import type { RomAccess, RomSession } from "./rom-onboarding-seams";

/**
 * USB-Serial-JTAG ignores the baud rate; keeping the ROM rate avoids esptool-js reopening the
 * port, which the ESP32-S3's native USB can answer by re-enumerating.
 */
const BAUD_RATE = 115_200;
const RESET_HOLD_MILLISECONDS = 100;
/**
 * esptool-js 0.7.0's ESP32-S3 stub stops sending partway through a long read packet over
 * USB-Serial-JTAG (Ticket 15, on the 601): 4096-byte packets stall after about 770 bytes, while
 * 256-byte packets read reliably. So reads ask for 256-byte packets, one in flight (ADR-0112).
 */
const READ_PACKET_BYTES = 256;
const READ_PACKETS_IN_FLIGHT = 1;
const READ_PACKET_TIMEOUT_MILLISECONDS = 3_000;
const MD5_BYTES = 16;

/** What the esptool-js adapter needs from the page: the one granted port and the Web Lock. */
export type EsptoolRomInput = {
  /** The port the user's Connect gesture granted, re-found after a re-enumeration. */
  port(): Promise<WorkerSerialPort>;
  /** The `bwg-worker-serial` Web Lock, held for the whole ROM session. */
  acquireLock(): Promise<() => void>;
  /**
   * Refuses a board before anything is written, given its factory base MAC. Required on the
   * owner's boards (ADR-0112): a sitting passes `baseMacAdmission` with the board's registered
   * digest. Awaited, since the digest is computed with WebCrypto; it never reaches evidence.
   */
  maybeAdmitBaseMac?: (baseMac: string) => boolean | Promise<boolean>;
};

/**
 * ROM bootloader access through esptool-js (pinned in `package.json`, ADR-0111). Its log, which
 * includes the chip's MAC, is discarded. Writes use `keep` flash parameters so the signed
 * bootloader's header is written unchanged and reads back byte for byte.
 */
export function esptoolRomAccess(input: EsptoolRomInput): RomAccess {
  return {
    async enter() {
      const release = await input.acquireLock();
      let maybeTransport: Transport | undefined;
      let entered = false;
      try {
        const port = await input.port();
        const transport = new Transport(port as unknown as ConstructorParameters<typeof Transport>[0], false);
        maybeTransport = transport;
        const loader = new ESPLoader({
          transport,
          baudrate: BAUD_RATE,
          romBaudrate: BAUD_RATE,
          terminal: { clean: () => undefined, write: () => undefined, writeLine: () => undefined },
        });
        await loader.main("default_reset");
        if (input.maybeAdmitBaseMac && !(await input.maybeAdmitBaseMac(await loader.chip.readMac(loader)))) {
          throw new Error("the board's base MAC is not the expected board's");
        }
        const session = esptoolSession(loader, transport, release);
        entered = true;
        return session;
      } catch (error) {
        throw await closedAfterFailure(maybeTransport, error);
      } finally {
        // The session owns the lock once entered; a failed entry gives it back, closed or not.
        if (!entered) release();
      }
    },
  };
}

/** Closes a port esptool-js may have opened, keeping both errors if closing fails too. */
async function closedAfterFailure(maybeTransport: Transport | undefined, error: unknown): Promise<unknown> {
  if (!maybeTransport || maybeTransport.device.readable === null) return error;
  try {
    await maybeTransport.disconnect();
    return error;
  } catch (closeError) {
    return new AggregateError([error, closeError], "ROM entry failed and its port did not close");
  }
}

function esptoolSession(loader: ESPLoader, transport: Transport, release: () => void): RomSession {
  let open = true;
  const live = () => {
    if (!open) throw new Error("ROM session is closed");
  };
  return {
    async readFlash(offset, length) {
      live();
      return readFlashInSmallPackets(loader, transport, offset, length);
    },
    async writeFlash(offset, data) {
      live();
      await loader.writeFlash({
        fileArray: [{ data: data.slice(), address: offset }],
        flashMode: "keep",
        flashFreq: "keep",
        flashSize: "keep",
        eraseAll: false,
        compress: true,
      });
    },
    async flashMd5Hex(offset, length) {
      live();
      return (await loader.flashMd5sum(offset, length)).toLowerCase();
    },
    async resetToApp() {
      live();
      open = false;
      try {
        // IO0 high (DTR false), then a pulse on EN (RTS): a hard reset into the app.
        await transport.setDTR(false);
        await transport.setRTS(true);
        await new Promise((resolve) => setTimeout(resolve, RESET_HOLD_MILLISECONDS));
        await transport.setRTS(false);
        await transport.disconnect();
      } finally {
        release();
      }
    },
  };
}

/**
 * The stub's read-flash exchange, as esptool.py runs it: data packets of the size asked for, each
 * acknowledged with the bytes received so far, then the MD5 of the whole read, which is checked.
 * esptool-js's own `readFlash` asks for 4096-byte packets and leaves the MD5 unread.
 */
async function readFlashInSmallPackets(
  loader: ESPLoader,
  transport: Transport,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const request = littleEndianWords(offset, length, READ_PACKET_BYTES, READ_PACKETS_IN_FLIGHT);
  const status = await loader.checkCommand("read flash", loader.ESP_READ_FLASH, request);
  if (status !== 0) throw new Error("the stub refused the flash read");
  const data = new Uint8Array(length);
  let received = 0;
  while (received < length) {
    const packet = await transport.read(READ_PACKET_TIMEOUT_MILLISECONDS);
    if (packet.length === 0 || received + packet.length > length) throw new Error("the flash read returned the wrong number of bytes");
    data.set(packet, received);
    received += packet.length;
    await transport.write(littleEndianWords(received));
  }
  const digest = await transport.read(READ_PACKET_TIMEOUT_MILLISECONDS);
  const expected = md5(data);
  if (digest.length !== MD5_BYTES || !digest.every((byte, index) => byte === expected[index])) {
    throw new Error("the flash read digest doesn't match the bytes read");
  }
  return data;
}

function littleEndianWords(...words: number[]): Uint8Array {
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  words.forEach((value, index) => view.setUint32(index * 4, value, true));
  return bytes;
}
