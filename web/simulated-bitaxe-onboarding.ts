import {
  type BitaxeDeviceSnapshot,
  type BitaxeOnboardingDevice,
  type MigrationSettings,
  type OtaSlot,
  type PartitionSlot,
  type RedactedSettingsVerification,
} from "./bitaxe-onboarding";
import {
  parseNvsSettingEntries,
  settingsCategoryHmacs,
  type NvsSettingEntry,
} from "./bitaxe-settings-hmac";
import { encodeBase64Url } from "./crypto-bytes";

/** Complete non-secret initial device state accepted by the deterministic simulator. */
export type SimulatedBitaxeSnapshot = BitaxeDeviceSnapshot;

/** Deterministic fault controls for the simulated device. */
export type SimulatedBitaxeOptions = {
  failFirstVerification?: boolean;
  failFlashAfterWrite?: boolean;
  /** Settings the device holds once the image boots, as if the new image changed NVS. */
  maybeSettingsAfterFlash?: readonly NvsSettingEntry[];
};

/** Deterministic explicit-device-selection seam for browser and package consumers. */
export class SimulatedBitaxeConnector {
  readonly #device: SimulatedBitaxeDevice;
  #requests = 0;

  constructor(
    snapshot: SimulatedBitaxeSnapshot,
    settings: readonly NvsSettingEntry[],
    options: SimulatedBitaxeOptions = {},
  ) {
    this.#device = new SimulatedBitaxeDevice(snapshot, settings, options);
  }

  /** Records and returns the simulator device selected by an explicit request. */
  async requestDevice(): Promise<BitaxeOnboardingDevice> {
    this.#requests += 1;
    return this.#device;
  }

  /** Returns how many explicit local-device requests reached the connector. */
  requestCount(): number {
    return this.#requests;
  }

  /** Exposes the deterministic device for conformance assertions and fault controls. */
  device(): SimulatedBitaxeDevice {
    return this.#device;
  }
}

/**
 * In-memory `esp32-factory-ota-ab` device. Its simulated `nvs` partition is the JSON of its
 * `main` entries, not the ESP-IDF page format, which the production device parses instead.
 */
export class SimulatedBitaxeDevice implements BitaxeOnboardingDevice {
  #snapshot: SimulatedBitaxeSnapshot;
  #settings: readonly NvsSettingEntry[];
  #maybePreviousSnapshot: SimulatedBitaxeSnapshot | undefined;
  #flashCount = 0;
  #rollbackCount = 0;
  #maximumPlaintextBytes = 0;
  #options: SimulatedBitaxeOptions;
  #maybeFlashedImage?: Uint8Array;
  #verificationNonces: string[] = [];

  constructor(
    snapshot: SimulatedBitaxeSnapshot,
    settings: readonly NvsSettingEntry[],
    options: SimulatedBitaxeOptions,
  ) {
    this.#snapshot = structuredClone(snapshot);
    this.#settings = structuredClone(settings);
    this.#options = { ...options };
  }

  /** Returns a defensive copy of the current strict device snapshot. */
  async inspect(): Promise<BitaxeDeviceSnapshot> {
    return structuredClone(this.#snapshot);
  }

  /** Returns the bounded simulated `nvs` partition and its decoded entries. */
  async readMigrationSettings(maximumBytes: number): Promise<MigrationSettings> {
    const nvsPartition = simulatedPartition(this.#settings);
    if (nvsPartition.byteLength > maximumBytes) {
      nvsPartition.fill(0);
      throw new Error("settings exceed the bounded migration window");
    }
    this.#maximumPlaintextBytes = Math.max(this.#maximumPlaintextBytes, nvsPartition.byteLength);
    return { nvsPartition, entries: structuredClone(this.#settings) };
  }

  /** Simulates writing an admitted image to the inactive OTA slot; NVS is untouched. */
  async flash(input: {
    image: Uint8Array;
    firmwareVersion: string;
    targetSlot: OtaSlot;
  }): Promise<void> {
    if (input.image.byteLength === 0) throw new Error("firmware image is empty");
    if (input.targetSlot === this.#snapshot.partition.activeSlot) {
      throw new Error("the running slot cannot be written");
    }
    this.#maybePreviousSnapshot = structuredClone(this.#snapshot);
    this.#maybeFlashedImage = input.image.slice();
    this.#snapshot.partition.activeSlot = input.targetSlot;
    this.#snapshot.partition.bootable = true;
    this.#snapshot.capabilities.firmware = {
      name: "bright-builds-reference-firmware",
      version: input.firmwareVersion,
    };
    this.#snapshot.capabilities.compatibility.referenceFirmware = true;
    this.#snapshot.capabilities.compatibility.settingsPreservation = "compatible";
    if (this.#options.maybeSettingsAfterFlash) {
      this.#settings = structuredClone(this.#options.maybeSettingsAfterFlash);
    }
    this.#flashCount += 1;
    if (this.#options.failFlashAfterWrite) {
      this.#options.failFlashAfterWrite = false;
      throw new Error("simulated flash interruption");
    }
  }

  /** Simulates a reboot after flashing or rollback. */
  async reboot(): Promise<void> {}

  /** Returns strict redacted state with category HMACs keyed by the browser's nonce. */
  async verifyRedactedSettings(nonce: Uint8Array): Promise<RedactedSettingsVerification> {
    const echoedNonce = encodeBase64Url(nonce);
    this.#verificationNonces.push(echoedNonce);
    const proof = {
      runningFirmwareVersion: this.#snapshot.capabilities.firmware.version,
      settingsSchemaVersion: this.#snapshot.settingsSchemaVersion,
      activeSlot: this.#snapshot.partition.activeSlot,
      bootable: this.#snapshot.partition.bootable,
      nonce: echoedNonce,
      categories: await settingsCategoryHmacs(
        this.#settings,
        this.#snapshot.settingsSchemaVersion,
        nonce,
      ),
    };
    if (this.#options.failFirstVerification) {
      this.#options.failFirstVerification = false;
      return { preservationConfirmed: false, ...proof };
    }
    return { preservationConfirmed: true, ...proof };
  }

  /** Points `otadata` back at the untouched previous slot and writes the `nvs` copy back. */
  async rollback(input: { slot: PartitionSlot; nvsPartition: Uint8Array }): Promise<void> {
    const maybePrevious = this.#maybePreviousSnapshot;
    if (!maybePrevious || maybePrevious.partition.activeSlot !== input.slot) {
      throw new Error("rollback image is unavailable");
    }
    this.#settings = parseSimulatedPartition(input.nvsPartition);
    this.#snapshot = maybePrevious;
    this.#maybePreviousSnapshot = undefined;
    this.#rollbackCount += 1;
  }

  /** Returns a defensive settings copy for conformance assertions. */
  settingsForTest(): readonly NvsSettingEntry[] {
    return structuredClone(this.#settings);
  }

  /** Replaces the device's settings, as if the running image changed NVS. */
  replaceSettingsForTest(settings: readonly NvsSettingEntry[]): void {
    this.#settings = structuredClone(settings);
  }

  /** Returns every nonce a verification was asked under, as base64url. */
  verificationNoncesForTest(): readonly string[] {
    return [...this.#verificationNonces];
  }

  /** Returns the number of simulated image writes. */
  flashCount(): number {
    return this.#flashCount;
  }

  /** Returns the number of confirmed simulated rollback operations. */
  rollbackCount(): number {
    return this.#rollbackCount;
  }

  /** Reports the largest admitted plaintext settings buffer observed by the device. */
  maximumPlaintextBytesObserved(): number {
    return this.#maximumPlaintextBytes;
  }

  /** Returns the most recently admitted image copy for immutable-input assertions. */
  flashedImageForTest(): Uint8Array | undefined {
    return this.#maybeFlashedImage?.slice();
  }
}

/** Serializes entries into the simulator's stand-in for a raw `nvs` partition. */
export function simulatedPartition(settings: readonly NvsSettingEntry[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(settings));
}

function parseSimulatedPartition(nvsPartition: Uint8Array): readonly NvsSettingEntry[] {
  return parseNvsSettingEntries(JSON.parse(new TextDecoder().decode(nvsPartition)));
}
