import type { WorkerControllerCapabilities } from "./worker-controller-semantics";

/**
 * One ROM bootloader session on the granted port. The chip stays in download mode until
 * `resetToApp`, which also releases the port.
 */
export interface RomSession {
  readFlash(offset: number, length: number): Promise<Uint8Array>;
  /** Erases the covered sectors and writes `data` exactly, with no image-header rewrite. */
  writeFlash(offset: number, data: Uint8Array): Promise<void>;
  /** The ROM stub's MD5 of a flash region, as lowercase hex. */
  flashMd5Hex(offset: number, length: number): Promise<string>;
  /** Hard-resets the chip into its app and releases the port. */
  resetToApp(): Promise<void>;
}

/** Resets the board into the ROM bootloader on the one granted port. */
export interface RomAccess {
  enter(): Promise<RomSession>;
}

/**
 * A Worker Serial session admitted with a fresh Hello and Device Identity possession, carrying
 * the two read-only onboarding commands of the C image (Ticket 03).
 */
export interface OnboardingSerialSession {
  readonly capabilities: WorkerControllerCapabilities;
  /**
   * `onboarding_inspect`: the snapshot without `capabilities`. Rejects with
   * `OnboardingCommandsUnsupportedError` when the admitted image doesn't route the command.
   */
  inspect(): Promise<unknown>;
  /** `onboarding_verify` with the base64url nonce. */
  verify(nonce: string): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * The running image sent no Hello acknowledgment, as stock ESP-Miner, which has no Worker Serial,
 * doesn't. Only this failure lets the device inspect the image from flash instead.
 */
export class NoWorkerSerialHelloError extends Error {
  constructor(options?: ErrorOptions) {
    super("the running image did not answer Worker Serial Hello", options);
    this.name = "NoWorkerSerialHelloError";
  }
}

/**
 * The running image answered Hello and passed possession but doesn't route `onboarding_inspect`:
 * a reference image built before Ticket 03, such as `247d2cd`. Its controller answers any command
 * it doesn't route with `command_rejected`/`invalid_request`, which the C image from Ticket 03 sends
 * for a payload-free `onboarding_inspect` only when it has no onboarding commands. Only this
 * failure, besides `NoWorkerSerialHelloError`, lets the device inspect the image from flash.
 */
export class OnboardingCommandsUnsupportedError extends Error {
  constructor(options?: ErrorOptions) {
    super("the running image does not support onboarding_inspect", options);
    this.name = "OnboardingCommandsUnsupportedError";
  }
}

/** Opens Worker Serial sessions on the granted port; each needs a fresh Hello and possession. */
export interface OnboardingSerialLink {
  /**
   * Rejects with `NoWorkerSerialHelloError` when no Hello acknowledgment arrived. Any other
   * rejection means admission failed for another reason, such as an image that answered Hello
   * and then failed possession; that is a real failure, not a sign of stock.
   */
  connect(): Promise<OnboardingSerialSession>;
}

/** Timers, injected so tests run without real deadlines. `after` returns a cancel function. */
export type OnboardingClock = {
  after(milliseconds: number, listener: () => void): () => void;
};

/** The page's own timers. */
export const PAGE_ONBOARDING_CLOCK: OnboardingClock = {
  after(milliseconds, listener) {
    const timer = setTimeout(listener, milliseconds);
    return () => clearTimeout(timer);
  },
};

/** Resolves after `milliseconds` on `clock`. */
export function pause(clock: OnboardingClock, milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    clock.after(milliseconds, resolve);
  });
}

/**
 * Deadlines for every step, chosen under Ticket 02's rules: each ends in a rollback or a clear
 * error, never a hang. These are proposed values; the Gamma 601 sitting measures them.
 */
export type RomOnboardingBounds = {
  /** Hello and possession on a running image, at Connect and after each reboot attempt. */
  helloMilliseconds: number;
  /** Reset into download mode, sync and stub upload. */
  romEntryMilliseconds: number;
  /** One flash read of the table, `otadata`, an app descriptor or NVS. */
  romReadMilliseconds: number;
  /** One small write (bootloader, table, `otadata`, NVS) with its read-back. */
  romSmallWriteMilliseconds: number;
  /** The app image write with its MD5 check. */
  romImageWriteMilliseconds: number;
  /** The MD5 of a whole app slot, taken before install and checked on rollback. */
  romSlotMd5Milliseconds: number;
  /** From reset until the new image is bootable: past its 120 s startup check, with margin. */
  deviceBackMilliseconds: number;
  /** Pause between Worker Serial attempts while the image boots. */
  reconnectPauseMilliseconds: number;
  /** Pause after resetting into an image without Worker Serial, which can't be observed. */
  unobservedBootMilliseconds: number;
};

/** Proposed bounds, to be measured on the 601 (Ticket 04). */
export const PROPOSED_ROM_ONBOARDING_BOUNDS: RomOnboardingBounds = {
  helloMilliseconds: 10_000,
  romEntryMilliseconds: 15_000,
  romReadMilliseconds: 15_000,
  romSmallWriteMilliseconds: 20_000,
  romImageWriteMilliseconds: 240_000,
  romSlotMd5Milliseconds: 60_000,
  deviceBackMilliseconds: 180_000,
  reconnectPauseMilliseconds: 2_000,
  unobservedBootMilliseconds: 10_000,
};

/** Rejects with a step-named error when `operation` outlasts its bound. */
export function withinBound<T>(
  clock: OnboardingClock,
  milliseconds: number,
  step: string,
  operation: Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = clock.after(milliseconds, () =>
      reject(new Error(`${step} did not finish within ${String(milliseconds)} ms`)),
    );
    operation.then(
      (value) => {
        cancel();
        resolve(value);
      },
      (error: unknown) => {
        cancel();
        reject(error);
      },
    );
  });
}
