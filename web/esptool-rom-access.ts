import { ESPLoader, Transport } from "esptool-js";
import type { WorkerSerialPort } from "./webserial-worker-port";
import type { RomAccess, RomSession } from "./rom-onboarding-seams";

/**
 * USB-Serial-JTAG ignores the baud rate; keeping the ROM rate avoids esptool-js reopening the
 * port, which the ESP32-S3's native USB can answer by re-enumerating.
 */
const BAUD_RATE = 115_200;
const RESET_HOLD_MILLISECONDS = 100;

/** What the esptool-js adapter needs from the page: the one granted port and the Web Lock. */
export type EsptoolRomInput = {
  /** The port the user's Connect gesture granted, re-found after a re-enumeration. */
  port(): Promise<WorkerSerialPort>;
  /** The `bwg-worker-serial` Web Lock, held for the whole ROM session. */
  acquireLock(): Promise<() => void>;
  /**
   * Refuses a board before anything is written, given its factory base MAC. The 601 sitting
   * passes the board's expected MAC from local configuration; it never reaches evidence.
   */
  maybeAdmitBaseMac?: (baseMac: string) => boolean;
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
        if (input.maybeAdmitBaseMac && !input.maybeAdmitBaseMac(await loader.chip.readMac(loader))) {
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
      return loader.readFlash(offset, length);
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
