import {
  type BitaxeDeviceSnapshot,
  type BitaxeOnboardingDevice,
  type RedactedSettingsVerification,
} from "./bitaxe-onboarding";
import { canonicalJson } from "./headless-values";
import { sha256Base64UrlBytes } from "./crypto-bytes";

/** Complete non-secret initial device state accepted by the deterministic simulator. */
export type SimulatedBitaxeSnapshot = BitaxeDeviceSnapshot;

/** Deterministic explicit-device-selection seam for browser and package consumers. */
export class SimulatedBitaxeConnector {
  readonly #device: SimulatedBitaxeDevice;
  #requests = 0;

  constructor(
    snapshot: SimulatedBitaxeSnapshot,
    settings: Uint8Array,
    options: { failFirstVerification?: boolean; failFlashAfterWrite?: boolean } = {},
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

/** In-memory A/B firmware and settings device with deterministic recovery controls. */
export class SimulatedBitaxeDevice implements BitaxeOnboardingDevice {
  #snapshot: SimulatedBitaxeSnapshot;
  #settings: Uint8Array;
  #maybeRollbackSnapshot?: SimulatedBitaxeSnapshot;
  #maybeRollbackSettings?: Uint8Array;
  #flashCount = 0;
  #rollbackCount = 0;
  #maximumPlaintextBytes = 0;
  #failFirstVerification: boolean;
  #failFlashAfterWrite: boolean;
  #rollbackConfirmed = false;
  #maybeFlashedImage?: Uint8Array;

  constructor(
    snapshot: SimulatedBitaxeSnapshot,
    settings: Uint8Array,
    options: { failFirstVerification?: boolean; failFlashAfterWrite?: boolean },
  ) {
    this.#snapshot = structuredClone(snapshot);
    this.#settings = settings.slice();
    this.#failFirstVerification = options.failFirstVerification === true;
    this.#failFlashAfterWrite = options.failFlashAfterWrite === true;
  }

  /** Returns a defensive copy of the current strict device snapshot. */
  async inspect(): Promise<BitaxeDeviceSnapshot> {
    return structuredClone(this.#snapshot);
  }

  /** Returns bounded migration settings or rejects before allocating a caller copy. */
  async readMigrationSettings(maximumBytes: number): Promise<Uint8Array> {
    if (this.#settings.byteLength > maximumBytes) {
      throw new Error("settings exceed the bounded migration window");
    }
    this.#maximumPlaintextBytes = Math.max(this.#maximumPlaintextBytes, this.#settings.byteLength);
    return this.#settings.slice();
  }

  /** Simulates writing an admitted image and preserved settings to the inactive A/B slot. */
  async flash(input: {
    image: Uint8Array;
    firmwareVersion: string;
    targetSettingsSchema: number;
    preservedSettings: Uint8Array;
  }): Promise<void> {
    if (input.image.byteLength === 0) throw new Error("firmware image is empty");
    this.#maybeRollbackSnapshot = structuredClone(this.#snapshot);
    this.#maybeRollbackSettings = this.#settings.slice();
    this.#settings = input.preservedSettings.slice();
    this.#maybeFlashedImage = input.image.slice();
    this.#snapshot.settingsSchemaVersion = input.targetSettingsSchema;
    this.#snapshot.partition.activeSlot =
      this.#snapshot.partition.activeSlot === "ota_0" ? "ota_1" : "ota_0";
    this.#snapshot.partition.bootable = true;
    this.#snapshot.capabilities.firmware = {
      name: "bright-builds-reference-firmware",
      version: input.firmwareVersion,
    };
    this.#snapshot.capabilities.compatibility.referenceFirmware = true;
    this.#snapshot.capabilities.compatibility.settingsPreservation = "compatible";
    this.#flashCount += 1;
    if (this.#failFlashAfterWrite) {
      this.#failFlashAfterWrite = false;
      throw new Error("simulated flash interruption");
    }
  }

  /** Simulates a reboot after flashing or rollback. */
  async reboot(): Promise<void> {}

  /** Returns strict redacted state and settings evidence for the running slot. */
  async verifyRedactedSettings(): Promise<RedactedSettingsVerification> {
    const proof = {
      runningFirmwareVersion: this.#snapshot.capabilities.firmware.version,
      settingsSchemaVersion: this.#snapshot.settingsSchemaVersion,
      activeSlot: this.#snapshot.partition.activeSlot,
      bootable: this.#snapshot.partition.bootable,
      rollbackState: this.#rollbackConfirmed ? "confirmed" as const : "available" as const,
      categories: await categoryDigests(this.#settings),
    };
    if (this.#failFirstVerification) {
      this.#failFirstVerification = false;
      return { preservationConfirmed: false, ...proof };
    }
    return { preservationConfirmed: true, ...proof };
  }

  /** Restores the exact pre-flash slot, firmware identity, and settings. */
  async rollback(): Promise<void> {
    if (!this.#maybeRollbackSnapshot || !this.#maybeRollbackSettings) {
      throw new Error("rollback image is unavailable");
    }
    this.#snapshot = this.#maybeRollbackSnapshot;
    this.#settings = this.#maybeRollbackSettings;
    this.#rollbackCount += 1;
    this.#rollbackConfirmed = true;
  }

  /** Returns a defensive settings copy for conformance assertions. */
  settingsForTest(): Uint8Array {
    return this.#settings.slice();
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

async function categoryDigests(
  settings: Uint8Array,
): Promise<readonly { category: "all" | "network" | "pool"; digestSha256: string }[]> {
  const parsed = JSON.parse(new TextDecoder().decode(settings)) as Record<string, unknown>;
  const network = Object.fromEntries(
    Object.entries(parsed).filter(([key]) => key.startsWith("wifi_")),
  );
  const pool = Object.fromEntries(Object.entries(parsed).filter(([key]) => key === "pool"));
  return [
    { category: "all", digestSha256: await digest(canonicalJson(parsed)) },
    { category: "network", digestSha256: await digest(canonicalJson(network)) },
    { category: "pool", digestSha256: await digest(canonicalJson(pool)) },
  ];
}

async function digest(value: string): Promise<string> {
  return sha256Base64UrlBytes(new TextEncoder().encode(value));
}
