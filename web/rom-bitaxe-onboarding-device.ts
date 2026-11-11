import { encodeBase64Url } from "./crypto-bytes";
import { parseDeviceSnapshot, parseVerification } from "./bitaxe-onboarding-boundaries";
import { md5Hex } from "./esp-flash-digests";
import { APP_DESCRIPTOR_READ_BYTES } from "./esp-app-image";
import { parseNvsPartition } from "./esp-nvs";
import { OTA_IMAGE_STATE, otadataBooting, selectedBootSlot } from "./esp-otadata";
import {
  BOOTLOADER_OFFSET,
  classifyPartitionTable,
  PARTITION_TABLE_BYTES,
  PARTITION_TABLE_OFFSET,
  partitionLayout,
  type KnownPartitionTable,
  type PartitionLayout,
} from "./esp-partition-table";
import { inspectFlash, verifyFlash, type RomFlashView } from "./bitaxe-rom-snapshot";
import {
  pause,
  withinBound,
  type OnboardingClock,
  type OnboardingSerialLink,
  type OnboardingSerialSession,
  type RomAccess,
  type RomOnboardingBounds,
  type RomSession,
} from "./rom-onboarding-seams";
import type {
  BitaxeDeviceSnapshot,
  BitaxeOnboardingDevice,
  FirstInstallImages,
  MigrationSettings,
  OtaSlot,
  PartitionSlot,
  RedactedSettingsVerification,
} from "./bitaxe-onboarding";

/** How the image that runs next is inspected and verified. */
type Observation = "worker_serial" | "rom";

/**
 * The production onboarding device (ADR-0111, ADR-0112). It writes only through the ROM
 * bootloader and reads the C image's facts and proof over Worker Serial. An image without
 * Worker Serial, such as stock ESP-Miner, is inspected and verified from flash through ROM.
 */
export class RomBitaxeOnboardingDevice implements BitaxeOnboardingDevice {
  #maybeSession: OnboardingSerialSession | undefined;
  #maybeRom: RomSession | undefined;
  #maybeOriginalObservation: Observation | undefined;
  #nextObservation: Observation = "worker_serial";
  #maybePreviousSlot: { slot: PartitionSlot; md5: string } | undefined;
  #maybeLastAttemptError: unknown;

  constructor(
    private readonly rom: RomAccess,
    private readonly link: OnboardingSerialLink,
    private readonly bounds: RomOnboardingBounds,
    private readonly clock: OnboardingClock,
  ) {}

  /** Worker Serial when the image answers Hello, possession and `onboarding_inspect`; else flash. */
  async inspect(): Promise<BitaxeDeviceSnapshot> {
    if (this.#maybeOriginalObservation === undefined) {
      const maybeSnapshot = await this.#maybeWorkerSerialSnapshot();
      this.#maybeOriginalObservation = maybeSnapshot ? "worker_serial" : "rom";
      this.#nextObservation = this.#maybeOriginalObservation;
      if (maybeSnapshot) return maybeSnapshot;
    }
    if (this.#nextObservation === "worker_serial") {
      const session = this.#requireSession();
      return this.#bounded("onboarding_inspect", this.helloBound, sessionSnapshot(session));
    }
    return this.#withRomThenApp(async (rom) => inspectFlash(await this.#flashView(rom)).snapshot);
  }

  /** Reads the raw `nvs` partition through ROM and leaves the chip in download mode to flash. */
  async readMigrationSettings(maximumBytes: number): Promise<MigrationSettings> {
    const rom = await this.#enterRom();
    const table = await this.#readTable(rom);
    const { nvs } = partitionLayout(table);
    if (nvs.size > maximumBytes) throw new Error("settings exceed the bounded migration window");
    const nvsPartition = await this.#read(rom, nvs.offset, nvs.size);
    return { nvsPartition, entries: parseNvsPartition(nvsPartition) };
  }

  /**
   * Checks the table, records the running slot's MD5, writes the image to `targetSlot` and checks
   * its MD5; from upstream's table, writes and reads back the C bootloader and C table; then
   * points `otadata` at `targetSlot` as `NEW`, so the C bootloader boots it pending.
   */
  async flash(input: {
    image: Uint8Array;
    firmwareVersion: string;
    targetSlot: OtaSlot;
    firstInstall: FirstInstallImages;
  }): Promise<void> {
    const rom = await this.#enterRom();
    const table = await this.#readTable(rom);
    const layout = partitionLayout(table);
    const otadata = await this.#read(rom, layout.otadata.offset, layout.otadata.size);
    const running = selectedBootSlot(otadata).slot;
    const target = layout[input.targetSlot];
    if (input.targetSlot === running) throw new Error("the running slot cannot be written");
    if (input.image.byteLength === 0 || input.image.byteLength > target.size) {
      throw new Error("firmware image does not fit the target slot");
    }
    this.#maybePreviousSlot = { slot: running, md5: await this.#slotMd5(rom, layout, running) };
    await this.#bounded("image write", this.bounds.romImageWriteMilliseconds, writeImage(rom, target.offset, input.image));
    if (table === "upstream") {
      await this.#writeExact(rom, BOOTLOADER_OFFSET, input.firstInstall.bootloader, "bootloader write");
      await this.#writeExact(rom, PARTITION_TABLE_OFFSET, input.firstInstall.partitionTable, "partition table write");
      if ((await this.#readTable(rom)) !== "c") throw new Error("the written partition table is not the C table");
    }
    const pending = otadataBooting(otadata, input.targetSlot, OTA_IMAGE_STATE.new);
    await this.#writeExact(rom, layout.otadata.offset, pending, "otadata write");
    this.#nextObservation = "worker_serial";
  }

  /** Resets into the app; for an image with Worker Serial, waits until it is back and bootable. */
  async reboot(): Promise<void> {
    await this.#closeSession();
    const rom = this.#maybeRom ?? (await this.#enterRom());
    this.#maybeRom = undefined;
    await this.#bounded("reset to app", this.bounds.romEntryMilliseconds, rom.resetToApp());
    if (this.#nextObservation === "rom") {
      await pause(this.clock, this.bounds.unobservedBootMilliseconds);
      return;
    }
    this.#maybeSession = await this.#awaitBootableImage();
  }

  async verifyRedactedSettings(nonce: Uint8Array): Promise<RedactedSettingsVerification> {
    if (this.#nextObservation === "worker_serial") {
      const session = this.#requireSession();
      const echoed = encodeBase64Url(nonce);
      const reply = await this.#bounded("onboarding_verify", this.helloBound, session.verify(echoed));
      return parseVerification(reply, echoed);
    }
    return this.#withRomThenApp(async (rom) => verifyFlash(await this.#flashView(rom), nonce));
  }

  /**
   * Points `otadata` back at `slot`, writes the `nvs` copy back, and reads both back; each is
   * written only when flash differs. The previous slot must still have the MD5 it had before
   * the install. Bootloader and table stay C's, which boot stock as well.
   */
  async rollback(input: { slot: PartitionSlot; nvsPartition: Uint8Array }): Promise<void> {
    await this.#closeSession();
    const rom = await this.#enterRom();
    const layout = partitionLayout(await this.#readTable(rom));
    if (input.nvsPartition.byteLength !== layout.nvs.size) {
      throw new Error("the settings copy does not match the nvs partition");
    }
    const otadata = await this.#read(rom, layout.otadata.offset, layout.otadata.size);
    const restored = otadataBooting(otadata, input.slot, OTA_IMAGE_STATE.valid);
    await this.#writeIfChanged(rom, layout.otadata.offset, otadata, restored, "otadata write");
    const nvs = await this.#read(rom, layout.nvs.offset, layout.nvs.size);
    await this.#writeIfChanged(rom, layout.nvs.offset, nvs, input.nvsPartition, "nvs restore");
    nvs.fill(0);
    const maybePrevious = this.#maybePreviousSlot;
    if (maybePrevious?.slot === input.slot && (await this.#slotMd5(rom, layout, input.slot)) !== maybePrevious.md5) {
      throw new Error("the previous slot changed during onboarding");
    }
    this.#nextObservation = this.#maybeOriginalObservation ?? "rom";
  }

  /** Ends any Worker Serial session and leaves a chip in download mode running its app. */
  async release(): Promise<void> {
    await this.#closeSession();
    const maybeRom = this.#maybeRom;
    this.#maybeRom = undefined;
    if (maybeRom) await this.#bounded("reset to app", this.bounds.romEntryMilliseconds, maybeRom.resetToApp());
  }

  private get helloBound(): number {
    return this.bounds.helloMilliseconds;
  }

  async #maybeWorkerSerialSnapshot(): Promise<BitaxeDeviceSnapshot | undefined> {
    let maybeSession: OnboardingSerialSession | undefined;
    try {
      maybeSession = await this.#bounded("Hello and possession", this.helloBound, this.link.connect());
      const snapshot = await this.#bounded("onboarding_inspect", this.helloBound, sessionSnapshot(maybeSession));
      this.#maybeSession = maybeSession;
      return snapshot;
    } catch {
      // No Hello, no possession or no onboarding commands: the image is inspected from flash.
      await maybeSession?.close();
      return undefined;
    }
  }

  async #awaitBootableImage(): Promise<OnboardingSerialSession> {
    let expired = false;
    const cancel = this.clock.after(this.bounds.deviceBackMilliseconds, () => {
      expired = true;
    });
    try {
      while (!expired) {
        const maybeSession = await this.#maybeBootableSession(() => expired);
        if (maybeSession) return maybeSession;
        await pause(this.clock, this.bounds.reconnectPauseMilliseconds);
      }
    } finally {
      cancel();
    }
    throw new Error(`the device was not back within ${String(this.bounds.deviceBackMilliseconds)} ms`, {
      cause: this.#maybeLastAttemptError,
    });
  }

  /** One fresh Hello and possession, then `onboarding_inspect` until the image is bootable. */
  async #maybeBootableSession(expired: () => boolean): Promise<OnboardingSerialSession | undefined> {
    let maybeSession: OnboardingSerialSession | undefined;
    try {
      maybeSession = await this.#bounded("Hello and possession", this.helloBound, this.link.connect());
      while (!expired()) {
        const snapshot = await this.#bounded("onboarding_inspect", this.helloBound, sessionSnapshot(maybeSession));
        if (snapshot.partition.bootable) return maybeSession;
        await pause(this.clock, this.bounds.reconnectPauseMilliseconds);
      }
    } catch (error) {
      // The image may still be booting or rolling itself back; the overall deadline decides.
      this.#maybeLastAttemptError = error;
    }
    await maybeSession?.close();
    return undefined;
  }

  async #withRomThenApp<T>(read: (rom: RomSession) => Promise<T>): Promise<T> {
    const rom = await this.#enterRom();
    try {
      return await read(rom);
    } finally {
      this.#maybeRom = undefined;
      await this.#bounded("reset to app", this.bounds.romEntryMilliseconds, rom.resetToApp());
    }
  }

  async #enterRom(): Promise<RomSession> {
    if (this.#maybeRom) return this.#maybeRom;
    await this.#closeSession();
    this.#maybeRom = await this.#bounded("ROM entry", this.bounds.romEntryMilliseconds, this.rom.enter());
    return this.#maybeRom;
  }

  async #closeSession(): Promise<void> {
    const maybeSession = this.#maybeSession;
    this.#maybeSession = undefined;
    await maybeSession?.close();
  }

  #requireSession(): OnboardingSerialSession {
    if (!this.#maybeSession) throw new Error("the device is not connected over Worker Serial");
    return this.#maybeSession;
  }

  async #flashView(rom: RomSession): Promise<RomFlashView> {
    const table = await this.#readTable(rom);
    const layout = partitionLayout(table);
    const otadata = await this.#read(rom, layout.otadata.offset, layout.otadata.size);
    const running = layout[selectedBootSlot(otadata).slot];
    return {
      table,
      otadata,
      runningSlotStart: await this.#read(rom, running.offset, APP_DESCRIPTOR_READ_BYTES),
      nvsPartition: await this.#read(rom, layout.nvs.offset, layout.nvs.size),
    };
  }

  async #readTable(rom: RomSession): Promise<KnownPartitionTable> {
    return classifyPartitionTable(await this.#read(rom, PARTITION_TABLE_OFFSET, PARTITION_TABLE_BYTES));
  }

  #read(rom: RomSession, offset: number, length: number): Promise<Uint8Array> {
    return this.#bounded("flash read", this.bounds.romReadMilliseconds, rom.readFlash(offset, length));
  }

  #slotMd5(rom: RomSession, layout: PartitionLayout, slot: PartitionSlot): Promise<string> {
    const region = layout[slot];
    return this.#bounded("slot MD5", this.bounds.romSlotMd5Milliseconds, rom.flashMd5Hex(region.offset, region.size));
  }

  async #writeIfChanged(rom: RomSession, offset: number, current: Uint8Array, wanted: Uint8Array, step: string): Promise<void> {
    if (sameBytes(current, wanted)) return;
    await this.#writeExact(rom, offset, wanted, step);
  }

  /** Writes `data` and requires the same bytes back. */
  async #writeExact(rom: RomSession, offset: number, data: Uint8Array, step: string): Promise<void> {
    await this.#bounded(step, this.bounds.romSmallWriteMilliseconds, rom.writeFlash(offset, data));
    const readBack = await this.#read(rom, offset, data.byteLength);
    const matches = sameBytes(readBack, data);
    readBack.fill(0);
    if (!matches) throw new Error(`${step} did not read back`);
  }

  #bounded<T>(step: string, milliseconds: number, operation: Promise<T>): Promise<T> {
    return withinBound(this.clock, milliseconds, step, operation);
  }
}

async function sessionSnapshot(session: OnboardingSerialSession): Promise<BitaxeDeviceSnapshot> {
  const facts = await session.inspect();
  if (typeof facts !== "object" || facts === null || Array.isArray(facts)) {
    throw new Error("Bitaxe onboarding snapshot is invalid");
  }
  return parseDeviceSnapshot({ capabilities: session.capabilities, ...facts });
}

async function writeImage(rom: RomSession, offset: number, image: Uint8Array): Promise<void> {
  await rom.writeFlash(offset, image);
  if ((await rom.flashMd5Hex(offset, image.byteLength)) !== md5Hex(image)) {
    throw new Error("the written image does not match its MD5");
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}
