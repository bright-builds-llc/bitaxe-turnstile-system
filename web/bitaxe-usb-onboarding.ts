import {
  createBitaxeOnboarding,
  type BitaxeOnboarding,
  type BitaxeOnboardingResult,
  type FirmwarePackage,
  type UpdateAuthorityJwk,
} from "./bitaxe-onboarding";
import { encodeBase64Url } from "./crypto-bytes";
import { esptoolRomAccess } from "./esptool-rom-access";
import { RomBitaxeOnboardingDevice } from "./rom-bitaxe-onboarding-device";
import {
  PAGE_ONBOARDING_CLOCK,
  pause,
  PROPOSED_ROM_ONBOARDING_BOUNDS,
  type OnboardingClock,
  type OnboardingSerialLink,
  type OnboardingSerialSession,
  type RomOnboardingBounds,
} from "./rom-onboarding-seams";
import { createMemoryWorkerContinuityAccess } from "./worker-continuity-store";
import { BrowserSerialController } from "./worker-serial-controller-runtime";
import {
  browserSerialRuntime,
  selectWorkerPort,
  type WorkerSerialAccess,
  type WorkerSerialBrowserRuntime,
  type WorkerSerialPort,
} from "./webserial-worker-port";

type DeviceFilter = { usbVendorId: number; usbProductId: number };

/** The bound on finding the granted port again after the chip resets and re-enumerates. */
const PORT_RETURN_MILLISECONDS = 10_000;
const PORT_POLL_MILLISECONDS = 250;

/**
 * The one port the user's "Connect Bitaxe over USB" gesture granted (ADR-0101, ADR-0112). ROM,
 * onboarding's Worker Serial sessions and, afterwards, the Worker Controller all use it. Only
 * `select` may show Chrome's chooser; later lookups re-find the same grant after a reset.
 */
export class GrantedBitaxePort {
  #maybePort: WorkerSerialPort | undefined;

  constructor(
    private readonly serial: WorkerSerialAccess,
    private readonly filter: DeviceFilter,
    private readonly clock: OnboardingClock,
  ) {}

  /** Runs in the gesture: reuses the single granted port or asks Chrome's chooser for one. */
  async select(): Promise<void> {
    const { port } = await selectWorkerPort(this.serial, this.filter);
    if (!port) throw new Error("no Bitaxe was chosen");
    this.#maybePort = port;
  }

  /** The selected port while it is attached; else the one granted, attached match, within a bound. */
  async current(): Promise<WorkerSerialPort> {
    const selected = this.#maybePort;
    if (!selected) throw new Error("Bitaxe USB connection is required");
    if (selected.connected !== false) return selected;
    for (let waited = 0; waited <= PORT_RETURN_MILLISECONDS; waited += PORT_POLL_MILLISECONDS) {
      const granted = this.serial.getPorts ? await this.serial.getPorts() : [];
      const matching = granted.filter((port) => {
        const info = port.getInfo();
        return port.connected !== false && info.usbVendorId === this.filter.usbVendorId && info.usbProductId === this.filter.usbProductId;
      });
      if (matching.length > 1) throw new Error("several Bitaxe boards are attached");
      const [maybeReturned] = matching;
      if (maybeReturned) {
        this.#maybePort = maybeReturned;
        return maybeReturned;
      }
      await pause(this.clock, PORT_POLL_MILLISECONDS);
    }
    throw new Error("the Bitaxe did not return on USB");
  }

  /** Serial access that can only hand out this grant: no chooser outside the gesture. */
  access(): WorkerSerialAccess {
    return {
      requestPort: () => Promise.reject(new Error("onboarding reconnects reuse the granted port")),
      getPorts: async () => [await this.current()],
    };
  }
}

/** Inputs for production onboarding on one Bitaxe over Web Serial. */
export type UsbBitaxeOnboardingInput = {
  deviceFilter: DeviceFilter;
  /** Update Authority keys: they verify both the package manifest and the C image's capability. */
  trustedUpdateKeys: readonly UpdateAuthorityJwk[];
  downloadMigrationBackup?: (encryptedBackup: Uint8Array) => Promise<void>;
  maybeAdmitBaseMac?: (baseMac: string) => boolean;
  maybeBounds?: RomOnboardingBounds;
  /** Tests replace the browser's serial runtime; production omits it. */
  maybeRuntime?: WorkerSerialBrowserRuntime;
};

/** A production onboarding and the release that ends its sessions on the granted port. */
export type UsbBitaxeOnboarding = { onboarding: BitaxeOnboarding; release(): Promise<void> };

/**
 * Builds onboarding whose device writes through ROM with esptool-js and reads the C image over
 * Worker Serial, all on the port the user's gesture granted. Construction touches no port.
 */
export function createUsbBitaxeOnboarding(input: UsbBitaxeOnboardingInput): UsbBitaxeOnboarding {
  const runtime = input.maybeRuntime ?? browserSerialRuntime();
  const clock = PAGE_ONBOARDING_CLOCK;
  const grant = new GrantedBitaxePort(runtime.serial, input.deviceFilter, clock);
  const device = new RomBitaxeOnboardingDevice(
    esptoolRomAccess({
      port: () => grant.current(),
      acquireLock: () => runtime.acquireLock(),
      ...(input.maybeAdmitBaseMac ? { maybeAdmitBaseMac: input.maybeAdmitBaseMac } : {}),
    }),
    workerSerialLink(runtime, grant, input),
    input.maybeBounds ?? PROPOSED_ROM_ONBOARDING_BOUNDS,
    clock,
  );
  const onboarding = createBitaxeOnboarding({
    requestDevice: async () => {
      await grant.select();
      return device;
    },
    trustedUpdateKeys: input.trustedUpdateKeys,
    ...(input.downloadMigrationBackup ? { downloadMigrationBackup: input.downloadMigrationBackup } : {}),
  });
  return { onboarding, release: () => device.release() };
}

/**
 * Worker Serial sessions for onboarding: the full Connect admission (lock, device filter, fresh
 * Hello, Device Identity possession) on the granted port, without a lease. The user's one
 * onboarding gesture stands for every reconnect it needs (ADR-0112), and continuity is held in
 * memory, so every session after the first must prove the same Device Identity.
 */
function workerSerialLink(
  runtime: WorkerSerialBrowserRuntime,
  grant: GrantedBitaxePort,
  input: UsbBitaxeOnboardingInput,
): OnboardingSerialLink {
  const onboardingRuntime: WorkerSerialBrowserRuntime = {
    ...runtime,
    serial: grant.access(),
    userActivation: () => true,
    foreground: () => true,
  };
  const scope = {
    challengeId: `onboarding_${encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)))}`,
    retentionExpiryUnixSeconds: Math.floor(Date.now() / 1000) + 3_600,
  };
  const continuity = createMemoryWorkerContinuityAccess(scope);
  return {
    async connect(): Promise<OnboardingSerialSession> {
      const controller = new BrowserSerialController(
        { deviceFilter: input.deviceFilter, trustedUpdateKeys: input.trustedUpdateKeys, continuityScope: scope },
        onboardingRuntime,
        continuity,
      );
      await controller.requestPermission();
      try {
        const capabilities = await controller.discover();
        return {
          capabilities,
          inspect: () => controller.onboardingInspect(),
          verify: (nonce) => controller.onboardingVerify(nonce),
          close: () => controller.close(),
        };
      } catch (error) {
        await controller.close();
        throw error;
      }
    },
  };
}

/** What the page asks the user for during one onboarding. */
export type BitaxeOnboardingPrompts = {
  /** The signed package to install, such as the one Ticket 05's owner signs. */
  loadFirmwarePackage(): Promise<FirmwarePackage>;
  /** A passphrase for the optional Migration Backup download, or `undefined` to skip it. */
  maybeBackupPassphrase(): Promise<string | undefined>;
  /** After a `ready` install: keep the C image, or roll back from the in-memory copy. */
  decide(result: BitaxeOnboardingResult): Promise<"complete" | "roll_back">;
};

/**
 * The work gate's "Connect Bitaxe over USB" action (`maybeOnboardBitaxe`): one fresh onboarding
 * per click, released before the gate loads its session, so the Worker Controller's Connect
 * reuses the same granted port. A rollback ends in an error, since the board isn't ready.
 */
export function bitaxeUsbOnboardingAction(
  create: () => UsbBitaxeOnboarding,
  prompts: BitaxeOnboardingPrompts,
): () => Promise<void> {
  return async () => {
    const { onboarding, release } = create();
    try {
      await onboarding.connect();
      const firmwarePackage = await prompts.loadFirmwarePackage();
      const maybeBackupPassphrase = await prompts.maybeBackupPassphrase();
      const result = await onboarding.install(
        firmwarePackage,
        maybeBackupPassphrase === undefined ? {} : { maybeBackupPassphrase },
      );
      if (result.status !== "ready") throw new Error("onboarding rolled back; the Bitaxe runs its previous firmware");
      if ((await prompts.decide(result)) === "roll_back") {
        await onboarding.rollBack();
        throw new Error("onboarding was rolled back at the user's request");
      }
      onboarding.complete();
    } finally {
      await release();
    }
  };
}
