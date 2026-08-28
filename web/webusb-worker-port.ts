import {
  admitWorkerWebUsbDescriptor,
  type WorkerWebUsbConfiguration,
} from "./webusb-worker-descriptor";
import type { WorkerUsbApplicationDescriptor } from "./worker-usb-profile";

const DEFAULT_TRANSFER_TIMEOUT_MILLISECONDS = 5_000;
const MAXIMUM_TRANSFER_TIMEOUT_MILLISECONDS = 30_000;

/** Exact deployment-assigned USB identifiers supplied to the browser chooser. */
export type WorkerWebUsbDeviceFilter = { vendorId: number; productId: number };
/** Redacted subset of a WebUSB OUT transfer result. */
export type WorkerWebUsbTransferOutResult = { status: string; bytesWritten?: number };
/** Redacted subset of a WebUSB IN transfer result. */
export type WorkerWebUsbTransferInResult = { status: string; data?: DataView };

/** Minimal WebUSB device surface kept injectable for browser conformance and host-independent tests. */
export interface WorkerWebUsbDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly serialNumber?: string;
  opened: boolean;
  configuration: WorkerWebUsbConfiguration | null;
  readonly configurations: readonly WorkerWebUsbConfiguration[];
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  selectAlternateInterface(interfaceNumber: number, alternateSetting: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  transferOut(endpointNumber: number, data: Uint8Array): Promise<WorkerWebUsbTransferOutResult>;
  transferIn(endpointNumber: number, length: number): Promise<WorkerWebUsbTransferInResult>;
}

/** Browser disconnect event for one already selected device object. */
export type WorkerWebUsbDisconnectEvent = { device: WorkerWebUsbDevice };

/** Browser WebUSB permission and disconnect surface used by the production adapter. */
export interface WorkerWebUsbAccess {
  requestDevice(options: {
    filters: readonly WorkerWebUsbDeviceFilter[];
  }): Promise<WorkerWebUsbDevice>;
  addEventListener(
    type: "disconnect",
    listener: (event: WorkerWebUsbDisconnectEvent) => void,
  ): void;
  removeEventListener(
    type: "disconnect",
    listener: (event: WorkerWebUsbDisconnectEvent) => void,
  ): void;
}

export type WorkerWebUsbRuntime = {
  usb: WorkerWebUsbAccess;
  deviceFilter: WorkerWebUsbDeviceFilter;
  userActivation: () => boolean;
  transferTimeoutMilliseconds: number;
};

/** Internal-only browser dependency injection key for repository conformance tests. */
export const workerWebUsbTestOptions = Symbol("workerWebUsbTestOptions");

export type WorkerWebUsbTestOptions = {
  usb: WorkerWebUsbAccess;
  userActivation: () => boolean;
};

export type AdmittedWorkerWebUsbDevice = {
  device: WorkerWebUsbDevice;
  descriptor: WorkerUsbApplicationDescriptor;
};

export class WorkerWebUsbTransferError extends Error {
  readonly phase: "control_lost" | "response_lost";

  constructor(phase: "control_lost" | "response_lost") {
    super("Worker WebUSB transfer failed");
    this.phase = phase;
  }
}

export function createWorkerWebUsbRuntime(input: {
  usb?: WorkerWebUsbAccess;
  deviceFilter: WorkerWebUsbDeviceFilter;
  userActivation?: () => boolean;
  transferTimeoutMilliseconds?: number;
}): WorkerWebUsbRuntime {
  validateFilter(input.deviceFilter);
  return {
    usb: input.usb ?? browserWebUsbAccess(),
    deviceFilter: structuredClone(input.deviceFilter),
    userActivation: input.userActivation ?? activeBrowserUserGesture,
    transferTimeoutMilliseconds: validTransferTimeout(input.transferTimeoutMilliseconds),
  };
}

export async function selectWorkerWebUsbDevice(
  runtime: WorkerWebUsbRuntime,
): Promise<AdmittedWorkerWebUsbDevice> {
  assertWorkerWebUsbUserActivation(runtime);
  const device = await runtime.usb.requestDevice({ filters: [runtime.deviceFilter] });
  try {
    validateSelectedDevice(device, runtime.deviceFilter);
    const descriptor = admitWorkerWebUsbDescriptor(device.configurations);
    await runBounded(device.open(), runtime.transferTimeoutMilliseconds);
    if (!device.configuration) {
      await runBounded(
        device.selectConfiguration(descriptor.configurationValue),
        runtime.transferTimeoutMilliseconds,
      );
    }
    if (device.configuration?.configurationValue !== descriptor.configurationValue) {
      throw new Error("Worker WebUSB application descriptor is invalid");
    }
    await runBounded(
      device.claimInterface(descriptor.control.interfaceNumber),
      runtime.transferTimeoutMilliseconds,
    );
    await runBounded(
      device.selectAlternateInterface(
        descriptor.control.interfaceNumber,
        descriptor.control.alternateSetting,
      ),
      runtime.transferTimeoutMilliseconds,
    );
    return {
      device,
      descriptor,
    };
  } catch (error) {
    await releaseAndCloseWorkerWebUsbDevice(device);
    throw normalizeAdmissionError(error);
  }
}

/** Fails before storage or USB effects unless the current browser task has user activation. */
export function assertWorkerWebUsbUserActivation(runtime: WorkerWebUsbRuntime): void {
  if (!runtime.userActivation()) {
    throw new Error("Worker WebUSB permission requires a direct user gesture");
  }
}

export async function transactWorkerWebUsb(
  device: WorkerWebUsbDevice,
  request: Uint8Array,
  maximumResponseBytes: number,
  timeoutMilliseconds: number,
): Promise<Uint8Array> {
  let writeCompleted = false;
  try {
    const output = await runBounded(device.transferOut(1, request), timeoutMilliseconds);
    if (output.status !== "ok" || output.bytesWritten !== request.byteLength) {
      throw new Error("output failed");
    }
    writeCompleted = true;
    const input = await runBounded(
      device.transferIn(1, maximumResponseBytes),
      timeoutMilliseconds,
    );
    if (input.status !== "ok" || !input.data) throw new Error("input failed");
    return copyDataView(input.data);
  } catch {
    throw new WorkerWebUsbTransferError(writeCompleted ? "response_lost" : "control_lost");
  }
}

export async function releaseAndCloseWorkerWebUsbDevice(
  device: WorkerWebUsbDevice,
): Promise<void> {
  if (!device.opened) return;
  try {
    await device.releaseInterface(0);
  } catch {
    // A disconnected device cannot release an interface; local state is already failed closed.
  }
  try {
    await device.close();
  } catch {
    // The browser may reject close after physical loss; no adapter reference remains usable.
  }
}

export async function releaseAndCloseWorkerWebUsbDeviceStrict(
  device: WorkerWebUsbDevice,
): Promise<void> {
  if (!device.opened) return;
  const errors: Error[] = [];
  try {
    await device.releaseInterface(0);
  } catch {
    errors.push(new Error("Worker WebUSB interface release failed"));
  }
  try {
    await device.close();
  } catch {
    errors.push(new Error("Worker WebUSB device close failed"));
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Worker WebUSB cleanup failed");
}

function activeBrowserUserGesture(): boolean {
  return typeof navigator !== "undefined" && navigator.userActivation?.isActive === true;
}

function browserWebUsbAccess(): WorkerWebUsbAccess {
  const maybeNavigator = typeof navigator === "undefined"
    ? undefined
    : (navigator as Navigator & { usb?: unknown });
  if (!maybeNavigator?.usb) throw new Error("Worker WebUSB is unavailable");
  return maybeNavigator.usb as WorkerWebUsbAccess;
}

function validateFilter(filter: WorkerWebUsbDeviceFilter): void {
  if (!usbIdentifier(filter.vendorId) || !usbIdentifier(filter.productId)) {
    throw new Error("Worker WebUSB device filter is invalid");
  }
}

function usbIdentifier(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 0xffff;
}

function validTransferTimeout(maybeTimeout: number | undefined): number {
  return validTimeout(
    maybeTimeout ?? DEFAULT_TRANSFER_TIMEOUT_MILLISECONDS,
    MAXIMUM_TRANSFER_TIMEOUT_MILLISECONDS,
    "Worker WebUSB timeout is invalid",
  );
}

function validTimeout(value: number, maximum: number, message: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error(message);
  return value;
}

function validateSelectedDevice(
  device: WorkerWebUsbDevice,
  filter: WorkerWebUsbDeviceFilter,
): void {
  if (
    device.vendorId !== filter.vendorId ||
    device.productId !== filter.productId
  ) {
    throw new Error("Worker WebUSB selected device is invalid");
  }
}

async function runBounded<T>(
  operation: Promise<T>,
  timeoutMilliseconds: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (result: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      result();
    };
    const timeout = setTimeout(
      () => finish(() => reject(new Error("Worker WebUSB operation timed out"))),
      timeoutMilliseconds,
    );
    operation.then(
      (value) => finish(() => resolve(value)),
      () => finish(() => reject(new Error("Worker WebUSB operation failed"))),
    );
  });
}

function copyDataView(view: DataView): Uint8Array {
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
}

function normalizeAdmissionError(error: unknown): Error {
  if (error instanceof Error && error.message.startsWith("Worker WebUSB")) return error;
  return new Error("Worker WebUSB device admission failed");
}
