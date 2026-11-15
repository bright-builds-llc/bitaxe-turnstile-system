/**
 * One owner's onboarding sitting on one of the owner's boards (Ticket 15): the production USB
 * onboarding, paused for the owner at each decision, with a redacted state for the evidence. It
 * holds no DOM; `bitaxe-onboarding-sitting-page.ts` binds it to the page.
 */
import type {
  BitaxeOnboarding,
  BitaxeOnboardingInspection,
  BitaxeOnboardingResult,
  FirmwarePackage,
} from "./bitaxe-onboarding";
import { baseMacAdmission } from "./bitaxe-base-mac-admission";
import {
  bitaxeUsbOnboardingAction,
  createUsbBitaxeOnboarding,
  type DeviceStepObserver,
  type DeviceStepOutcome,
  type UsbBitaxeOnboarding,
} from "./bitaxe-usb-onboarding";
import { parseWorkerDeploymentTrust, type WorkerDeploymentTrust } from "./worker-deployment-trust";

/** The owner's boards that ADR-0112 requires a base-MAC match on. */
const OWNER_BOARDS = ["205", "601"] as const;
/** The Gamma's ESP32-S3 USB-Serial-JTAG, as the Worker Serial pages filter it. */
const BITAXE_DEVICE_FILTER = { usbVendorId: 0x303a, usbProductId: 0x1001 };

/** Local configuration for one sitting, written privately and loaded through a file picker. */
export type SittingConfiguration = {
  board: (typeof OWNER_BOARDS)[number];
  expectedBaseMacSha256: string;
  trust: WorkerDeploymentTrust;
};

/** Parses the configuration file, refusing any board, digest or trust it doesn't know. */
export function parseSittingConfiguration(text: string): SittingConfiguration {
  const value = JSON.parse(text) as { board?: unknown; expectedBaseMacSha256?: unknown; trust?: unknown };
  const board = OWNER_BOARDS.find((known) => known === value.board);
  if (!board) throw new Error(`the configuration's board must be one of ${OWNER_BOARDS.join(", ")}`);
  const digest = value.expectedBaseMacSha256;
  if (typeof digest !== "string") throw new Error("the configuration's expected base-MAC digest is missing");
  baseMacAdmission(digest);
  return { board, expectedBaseMacSha256: digest, trust: parseWorkerDeploymentTrust(value.trust) };
}

/** The four package files as the owner picks them. Admission happens inside `install`. */
export type FirmwarePackageFiles = {
  /** The signer's output: `{ manifest, signature }`. */
  signedManifest: string;
  image: Uint8Array;
  bootloader: Uint8Array;
  partitionTable: Uint8Array;
};

/** Joins the signed manifest file with the bytes it signs. */
export function firmwarePackageFromFiles(files: FirmwarePackageFiles): FirmwarePackage {
  const signed = JSON.parse(files.signedManifest) as { manifest?: unknown; signature?: unknown };
  if (typeof signed.manifest !== "object" || signed.manifest === null || typeof signed.signature !== "string") {
    throw new Error("the signed manifest file must hold a manifest and a signature");
  }
  return {
    manifest: signed.manifest as FirmwarePackage["manifest"],
    image: files.image,
    bootloader: files.bootloader,
    partitionTable: files.partitionTable,
    signature: signed.signature,
  };
}

export type SittingStatus =
  | "configured"
  | "connecting"
  | "inspected"
  | "installing"
  | "installed"
  | "stopping"
  | "completing"
  | "rolling_back"
  | "stopped"
  | "completed"
  | "rolled_back"
  | "failed";

/** One device step as the evidence records it. */
export type SittingStep = { step: string; milliseconds: number; outcome: DeviceStepOutcome; error?: string };

/** What the page shows and DevTools reads: never a MAC, digest, passphrase or settings value. */
export type SittingState = {
  status: SittingStatus;
  board: SittingConfiguration["board"];
  inspection?: {
    action: BitaxeOnboardingInspection["action"];
    board: { model: string; revision: string };
    firmware: { name: string; version: string };
    referenceFirmware: boolean;
    settingsPreservation: string;
    settingsSchemaVersion: number;
    migrationBackup: BitaxeOnboardingInspection["migrationBackup"];
  };
  result?: {
    status: BitaxeOnboardingResult["status"];
    rollback: BitaxeOnboardingResult["rollback"];
    firmwareVersion: string;
    preservationConfirmed: boolean;
    runningFirmwareVersion: string;
    activeSlot: string;
    bootable: boolean;
    categories: readonly string[];
  };
  steps: readonly SittingStep[];
  error?: string;
};

/** Statuses at which the sitting waits for the owner or has ended. */
const RESTING: ReadonlySet<SittingStatus> = new Set([
  "inspected",
  "installed",
  "stopped",
  "completed",
  "rolled_back",
  "failed",
]);

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

export type OnboardingSittingInput = {
  configuration: SittingConfiguration;
  firmwarePackage: FirmwarePackage;
  /** Saves the encrypted Migration Backup; the page downloads it. */
  maybeDownloadMigrationBackup?: (encryptedBackup: Uint8Array) => Promise<void>;
  /** Tests substitute the onboarding; production builds the USB one for the configured board. */
  maybeCreate?: (observeStep: DeviceStepObserver) => UsbBitaxeOnboarding;
};

/** The owner's controls over one onboarding; each resolves once the sitting rests again. */
export type OnboardingSitting = {
  state(): SittingState;
  /** Runs in the Connect gesture: selects the port, admits the board and inspects it. */
  connect(): Promise<void>;
  install(options?: { maybeBackupPassphrase?: string }): Promise<void>;
  stopBeforeInstall(): Promise<void>;
  keep(): Promise<void>;
  rollBack(): Promise<void>;
};

/** Builds a sitting; nothing touches a port until `connect`. */
export function createOnboardingSitting(input: OnboardingSittingInput): OnboardingSitting {
  const create = input.maybeCreate ?? ((observeStep) => usbOnboarding(input, observeStep));
  let state: SittingState = { status: "configured", board: input.configuration.board, steps: [] };
  let waiters: Array<() => void> = [];
  let stopRequested = false;
  const packageChoice = deferred<FirmwarePackage>();
  const passphraseChoice = deferred<string | undefined>();
  const decision = deferred<"complete" | "roll_back">();

  const update = (change: Partial<SittingState>) => {
    state = { ...state, ...change };
    if (!RESTING.has(state.status)) return;
    const resting = waiters;
    waiters = [];
    for (const wake of resting) wake();
  };
  const rest = () => new Promise<void>((wake) => waiters.push(wake));
  const requireStatus = (status: SittingStatus, action: string) => {
    if (state.status !== status) throw new Error(`${action} needs the sitting to be ${status}, not ${state.status}`);
  };
  const observeStep: DeviceStepObserver = (step, milliseconds, outcome, maybeError) =>
    update({ steps: [...state.steps, { step, milliseconds, outcome, ...(maybeError === undefined ? {} : { error: maybeError }) }] });

  const recordResult = (result: BitaxeOnboardingResult) => update({ result: redactedResult(result) });
  const recorded = (usb: UsbBitaxeOnboarding): UsbBitaxeOnboarding => ({
    release: () => usb.release(),
    onboarding: recordingOnboarding(usb.onboarding, {
      inspected: (inspection) => update({ inspection: redactedInspection(inspection) }),
      result: recordResult,
    }),
  });

  const action = bitaxeUsbOnboardingAction(() => recorded(create(observeStep)), {
    loadFirmwarePackage: () => {
      update({ status: "inspected" });
      return packageChoice.promise;
    },
    maybeBackupPassphrase: () => passphraseChoice.promise,
    decide: () => {
      update({ status: "installed" });
      return decision.promise;
    },
  });

  return {
    state: () => structuredClone(state),
    connect() {
      requireStatus("configured", "Connect");
      update({ status: "connecting" });
      const resting = rest();
      action().then(
        () => update({ status: "completed" }),
        (error: unknown) => update(endAfter(error)),
      );
      return resting;
    },
    install(options = {}) {
      requireStatus("inspected", "Install");
      update({ status: "installing" });
      const resting = rest();
      packageChoice.resolve(input.firmwarePackage);
      passphraseChoice.resolve(options.maybeBackupPassphrase);
      return resting;
    },
    stopBeforeInstall() {
      requireStatus("inspected", "Stop before install");
      stopRequested = true;
      update({ status: "stopping" });
      const resting = rest();
      packageChoice.reject(new Error("the owner stopped before install"));
      return resting;
    },
    keep() {
      requireStatus("installed", "Keep");
      return choose("complete");
    },
    rollBack() {
      requireStatus("installed", "Roll back");
      return choose("roll_back");
    },
  };

  function choose(choice: "complete" | "roll_back"): Promise<void> {
    update({ status: choice === "complete" ? "completing" : "rolling_back" });
    const resting = rest();
    decision.resolve(choice);
    return resting;
  }

  /** How the action's rejection ends the sitting, once the port is released. */
  function endAfter(error: unknown): Partial<SittingState> {
    if (stopRequested) return { status: "stopped" };
    if (state.result?.status === "rolled_back") return { status: "rolled_back" };
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

/** The production onboarding for the configured board, refusing any other board before a write. */
function usbOnboarding(input: OnboardingSittingInput, observeStep: DeviceStepObserver): UsbBitaxeOnboarding {
  return createUsbBitaxeOnboarding({
    deviceFilter: BITAXE_DEVICE_FILTER,
    trustedUpdateKeys: input.configuration.trust.updateAuthority.keys,
    maybeAdmitBaseMac: baseMacAdmission(input.configuration.expectedBaseMacSha256),
    maybeObserveDeviceStep: observeStep,
    ...(input.maybeDownloadMigrationBackup ? { downloadMigrationBackup: input.maybeDownloadMigrationBackup } : {}),
  });
}

/** Delegates to `onboarding`, recording the inspection the action discards and every result. */
function recordingOnboarding(
  onboarding: BitaxeOnboarding,
  record: { inspected(inspection: BitaxeOnboardingInspection): void; result(result: BitaxeOnboardingResult): void },
): BitaxeOnboarding {
  const recordResult = (result: BitaxeOnboardingResult) => {
    record.result(result);
    return result;
  };
  return {
    connect: async () => {
      const inspection = await onboarding.connect();
      record.inspected(inspection);
      return inspection;
    },
    install: async (firmwarePackage, options) => recordResult(await onboarding.install(firmwarePackage, options)),
    rollbackState: () => onboarding.rollbackState(),
    complete: () => onboarding.complete(),
    rollBack: async (options) => recordResult(await onboarding.rollBack(options)),
  };
}

function redactedInspection(inspection: BitaxeOnboardingInspection): NonNullable<SittingState["inspection"]> {
  const { board, firmware, compatibility } = inspection.capabilities;
  return {
    action: inspection.action,
    board: { model: board.model, revision: board.revision },
    firmware: { name: firmware.name, version: firmware.version },
    referenceFirmware: compatibility.referenceFirmware,
    settingsPreservation: compatibility.settingsPreservation,
    settingsSchemaVersion: inspection.settingsSchemaVersion,
    migrationBackup: inspection.migrationBackup,
  };
}

/** The result without its HMACs: the categories it compared are enough for the evidence. */
function redactedResult(result: BitaxeOnboardingResult): NonNullable<SittingState["result"]> {
  const { verification } = result;
  return {
    status: result.status,
    rollback: result.rollback,
    firmwareVersion: result.firmwareVersion,
    preservationConfirmed: verification.preservationConfirmed,
    runningFirmwareVersion: verification.runningFirmwareVersion,
    activeSlot: verification.activeSlot,
    bootable: verification.bootable,
    categories: verification.categories.map((entry) => entry.category),
  };
}
