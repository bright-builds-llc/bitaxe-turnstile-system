import vector from "../conformance/bwg-bitaxe-onboarding-0.2/nvs-partition-vector.json";
import { decodeBase64Url, encodeBase64Url } from "./crypto-bytes";
import { md5Hex } from "./esp-flash-digests";
import { parseNvsPartition } from "./esp-nvs";
import { OTA_IMAGE_STATE, OTADATA_SECTOR_BYTES, selectedBootSlot } from "./esp-otadata";
import {
  encodePartitionTable,
  KNOWN_PARTITION_TABLES,
  PARTITION_TABLE_OFFSET,
  partitionLayout,
  type PartitionEntry,
} from "./esp-partition-table";
import { settingsCategoryHmacs } from "./bitaxe-settings-hmac";
import {
  NoWorkerSerialHelloError,
  OnboardingCommandsUnsupportedError,
  type OnboardingClock,
  type OnboardingSerialLink,
  type OnboardingSerialSession,
  type RomAccess,
  type RomOnboardingBounds,
  type RomSession,
} from "./rom-onboarding-seams";
import type { WorkerControllerCapabilities } from "./worker-controller-semantics";

const FLASH_BYTES = 0x100_0000;
const LAYOUT = partitionLayout("c");
/** Prefix by which the fake board recognises a C image, which answers Worker Serial. */
export const C_IMAGE_PREFIX = "reference-firmware";
/** The descriptor version of a reference image built before Ticket 03, such as `247d2cd`'s. */
export const PRE_ONBOARDING_VERSION = "v2.15.2rc0-80-g247d2cd";
/** Stand-in for a bootloader that isn't the signed C one, such as stock's or a pre-Ticket 03 image's. */
export const OTHER_BOOTLOADER = new Uint8Array([0xe9, 0x03, 0x02, 0x4f, ...new TextEncoder().encode("older-bootloader")]);

/** The NVS vector built by ESP-IDF's own generator: a Gamma 601's `main` namespace. */
export function vectorNvsPartition(): Uint8Array {
  const partition = new Uint8Array(vector.partitionBytes).fill(0xff);
  partition.set(Uint8Array.from(vector.prefixHex.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16)));
  return partition;
}

/** An app slot's first bytes as ESP-IDF lays them out: image header, segment header, app descriptor. */
export function appImage(projectName: string, version: string): Uint8Array {
  const image = new Uint8Array(0x400).fill(0);
  image[0] = 0xe9;
  new DataView(image.buffer).setUint32(32, 0xabcd5432, true);
  image.set(new TextEncoder().encode(version), 32 + 16);
  image.set(new TextEncoder().encode(projectName), 32 + 48);
  return image;
}

/** XORs `mask` into one byte, as a test's corruption of flash. */
export function flipBits(bytes: Uint8Array, index: number, mask = 0x01): void {
  bytes[index] = (bytes[index] ?? 0) ^ mask;
}

/** Every operation the board saw, in order, without any bytes. */
export type BoardOperation =
  | { op: "enter_rom" }
  | { op: "reset_to_app" }
  | { op: "read" | "write" | "md5"; region: string }
  | { op: "connect" | "inspect" | "verify" | "close" };

/**
 * A Gamma 601 in memory: 16 MiB of flash, a bootloader that honours `otadata` the way ESP-IDF's
 * does with app rollback on, and an app that is either stock (no Worker Serial) or the C image,
 * which marks itself valid once its startup check has passed `startupInspects` inspections.
 */
export class FakeBoard {
  readonly flash = new Uint8Array(FLASH_BYTES).fill(0xff);
  readonly log: BoardOperation[] = [];
  startupInspects = 1;
  /** Overrides the next `onboarding_verify` reply, as a C image that lies or loses settings. */
  maybeVerifyOverride: ((reply: Record<string, unknown>) => Record<string, unknown>) | undefined;
  /** When true, a C image never answers Hello: as if it never booted. */
  silent = false;
  /** When true, the running image answers Hello and then fails Device Identity possession. */
  possessionFails = false;
  /** When true, a C image rejects `onboarding_inspect` as one that supports it but failed. */
  inspectFails = false;
  #inRom = false;
  #inspects = 0;

  constructor(table: readonly PartitionEntry[] = KNOWN_PARTITION_TABLES.upstream) {
    this.flash.set(encodePartitionTable(table), PARTITION_TABLE_OFFSET);
    this.flash.set(vectorNvsPartition(), LAYOUT.nvs.offset);
    this.flash.set(appImage("esp-miner", "v2.10.1"), LAYOUT.factory.offset);
    this.flash.set(OTHER_BOOTLOADER, 0);
  }

  region(offset: number, length: number): Uint8Array {
    return this.flash.slice(offset, offset + length);
  }

  writes(): string[] {
    return this.log.flatMap((entry) => (entry.op === "write" ? [entry.region] : []));
  }

  rom(): RomAccess {
    return {
      enter: async () => {
        this.log.push({ op: "enter_rom" });
        this.#inRom = true;
        return this.#session();
      },
    };
  }

  link(capabilities: WorkerControllerCapabilities): OnboardingSerialLink {
    return {
      connect: async () => {
        this.log.push({ op: "connect" });
        const kind = this.#runningKind();
        if (this.#inRom || this.silent || kind === "stock") throw new NoWorkerSerialHelloError();
        if (this.possessionFails) throw new Error("possession_failed");
        return kind === "c" ? this.#serialSession(capabilities) : this.#preOnboardingSession(capabilities);
      },
    };
  }

  #session(): RomSession {
    const live = () => {
      if (!this.#inRom) throw new Error("ROM session is closed");
    };
    return {
      readFlash: async (offset, length) => {
        live();
        this.log.push({ op: "read", region: regionName(offset) });
        return this.region(offset, length);
      },
      writeFlash: async (offset, data) => {
        live();
        this.log.push({ op: "write", region: regionName(offset) });
        const sectorStart = Math.floor(offset / 0x1000) * 0x1000;
        const sectorEnd = Math.ceil((offset + data.byteLength) / 0x1000) * 0x1000;
        this.flash.fill(0xff, sectorStart, sectorEnd);
        this.flash.set(data, offset);
      },
      flashMd5Hex: async (offset, length) => {
        live();
        this.log.push({ op: "md5", region: regionName(offset) });
        return md5Hex(this.region(offset, length));
      },
      resetToApp: async () => {
        live();
        this.log.push({ op: "reset_to_app" });
        this.#inRom = false;
        this.#boot();
      },
    };
  }

  /** ESP-IDF's bootloader with rollback on: `NEW` becomes `PENDING_VERIFY`, a second boot aborts it. */
  #boot(): void {
    this.#inspects = 0;
    const otadata = this.region(LAYOUT.otadata.offset, LAYOUT.otadata.size);
    const selection = selectedBootSlot(otadata);
    if (selection.slot === "factory") return;
    const at = LAYOUT.otadata.offset + selection.sector * OTADATA_SECTOR_BYTES + 24;
    const view = new DataView(this.flash.buffer, at, 4);
    if (selection.state === OTA_IMAGE_STATE.new) view.setUint32(0, OTA_IMAGE_STATE.pendingVerify, true);
    else if (selection.state === OTA_IMAGE_STATE.pendingVerify) view.setUint32(0, OTA_IMAGE_STATE.aborted, true);
  }

  /** The C image by its prefix; a pre-Ticket 03 reference image by its descriptor version; else stock. */
  #runningKind(): "stock" | "pre_onboarding" | "c" {
    const selection = selectedBootSlot(this.region(LAYOUT.otadata.offset, LAYOUT.otadata.size));
    const start = this.region(LAYOUT[selection.slot].offset, 0x400);
    if (new TextDecoder().decode(start.subarray(0, C_IMAGE_PREFIX.length)) === C_IMAGE_PREFIX) return "c";
    const version = new TextDecoder().decode(start.subarray(48, 48 + PRE_ONBOARDING_VERSION.length));
    return version === PRE_ONBOARDING_VERSION ? "pre_onboarding" : "stock";
  }

  /** A reference image before Ticket 03: admitted over Worker Serial, without the onboarding commands. */
  #preOnboardingSession(capabilities: WorkerControllerCapabilities): OnboardingSerialSession {
    return {
      capabilities: structuredClone(capabilities),
      inspect: async () => {
        this.log.push({ op: "inspect" });
        throw new OnboardingCommandsUnsupportedError();
      },
      verify: async () => {
        this.log.push({ op: "verify" });
        throw new OnboardingCommandsUnsupportedError();
      },
      close: async () => {
        this.log.push({ op: "close" });
      },
    };
  }

  #facts() {
    const otadata = this.region(LAYOUT.otadata.offset, LAYOUT.otadata.size);
    const selection = selectedBootSlot(otadata);
    const bootable = selection.slot === "factory" || selection.state === OTA_IMAGE_STATE.valid;
    return { selection, bootable };
  }

  #serialSession(capabilities: WorkerControllerCapabilities): OnboardingSerialSession {
    return {
      capabilities: structuredClone(capabilities),
      inspect: async () => {
        this.log.push({ op: "inspect" });
        if (this.inspectFails) throw new Error("persistence_failed");
        this.#inspects += 1;
        const { selection } = this.#facts();
        if (selection.slot !== "factory" && this.#inspects >= this.startupInspects) {
          const at = LAYOUT.otadata.offset + selection.sector * OTADATA_SECTOR_BYTES + 24;
          new DataView(this.flash.buffer, at, 4).setUint32(0, OTA_IMAGE_STATE.valid, true);
        }
        const { selection: after, bootable } = this.#facts();
        return {
          settingsSchemaVersion: 1,
          settingsReadable: true,
          partition: {
            scheme: "esp32-factory-ota-ab",
            appSlotBytes: LAYOUT.ota_0.size,
            rollbackAvailable: true,
            activeSlot: after.slot,
            bootable,
          },
        };
      },
      verify: async (nonce) => {
        this.log.push({ op: "verify" });
        const { selection, bootable } = this.#facts();
        const key = decodeBase64Url(nonce, 43, "nonce is invalid");
        const entries = parseNvsPartition(this.region(LAYOUT.nvs.offset, LAYOUT.nvs.size));
        const reply = {
          preservationConfirmed: bootable,
          runningFirmwareVersion: capabilities.firmware.version,
          settingsSchemaVersion: 1,
          activeSlot: selection.slot,
          bootable,
          nonce: encodeBase64Url(key),
          categories: await settingsCategoryHmacs(entries, 1, key),
        };
        const maybeOverride = this.maybeVerifyOverride;
        this.maybeVerifyOverride = undefined;
        return maybeOverride ? maybeOverride(reply) : reply;
      },
      close: async () => {
        this.log.push({ op: "close" });
      },
    };
  }
}

/** A clock whose timers fire on the next macrotask, so every bound is short but still ordered. */
export function instantClock(): OnboardingClock {
  return {
    after(milliseconds, listener) {
      const timer = setTimeout(listener, Math.min(milliseconds, 5));
      return () => clearTimeout(timer);
    },
  };
}

/** Bounds that let a fake board answer, with a device-back window of a few attempts. */
export const TEST_BOUNDS: RomOnboardingBounds = {
  helloMilliseconds: 1_000,
  romEntryMilliseconds: 1_000,
  romReadMilliseconds: 1_000,
  romSmallWriteMilliseconds: 1_000,
  romImageWriteMilliseconds: 1_000,
  romSlotMd5Milliseconds: 1_000,
  deviceBackMilliseconds: 1_000,
  reconnectPauseMilliseconds: 0,
  unobservedBootMilliseconds: 0,
};

function regionName(offset: number): string {
  if (offset === 0) return "bootloader";
  if (offset === PARTITION_TABLE_OFFSET) return "partition_table";
  const maybeName = (Object.keys(LAYOUT) as (keyof typeof LAYOUT)[]).find(
    (name) => LAYOUT[name].offset === offset,
  );
  return maybeName ?? `0x${offset.toString(16)}`;
}
