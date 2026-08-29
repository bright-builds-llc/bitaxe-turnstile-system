import type { WorkerControllerDisconnectReason } from "./worker-controller";
import {
  createWorkerWebUsbRuntime,
  type WorkerWebUsbDeviceFilter,
  type WorkerWebUsbRuntime,
  type WorkerWebUsbTestOptions,
} from "./webusb-worker-port";

export type WorkerWebUsbAdapterState =
  | "unconnected" | "admitting" | "ready" | "restoration_pending" | "cleanup_pending" | "closed";

/** Builds the production/test WebUSB runtime from the one closed adapter input seam. */
export function configuredWorkerWebUsbRuntime(
  deviceFilter: WorkerWebUsbDeviceFilter,
  maybeTransferTimeoutMilliseconds: number | undefined,
  maybeTestOptions: WorkerWebUsbTestOptions | undefined,
): WorkerWebUsbRuntime {
  return createWorkerWebUsbRuntime({
    deviceFilter,
    ...(maybeTransferTimeoutMilliseconds === undefined
      ? {}
      : { transferTimeoutMilliseconds: maybeTransferTimeoutMilliseconds }),
    ...(maybeTestOptions
      ? { usb: maybeTestOptions.usb, userActivation: maybeTestOptions.userActivation }
      : {}),
  });
}

/** Identifies normalized device-side command rejection without exposing payload detail. */
export function isDeviceCommandRejection(error: unknown): boolean {
  return error instanceof Error &&
    [
      "Worker Controller USB request was invalid",
      "Worker Controller command was rejected",
    ].includes(error.message);
}

/** Maps transport internals to one stable browser-adapter failure. */
export function normalizeAdapterError(error: unknown): Error {
  if (error instanceof Error && error.message.startsWith("Worker WebUSB")) return error;
  return new Error("Worker WebUSB device admission failed");
}

/** Rejects public operations until local admission and restoration are complete. */
export function assertWorkerWebUsbReady(state: WorkerWebUsbAdapterState): void {
  if (state === "ready") return;
  throw new Error(
    state === "restoration_pending"
      ? "Worker WebUSB reacquisition is required"
      : "Worker WebUSB permission is required",
  );
}

/** Notifies every registered listener and fails if any restoration listener fails. */
export async function notifyWorkerDisconnect(
  listeners: ReadonlySet<(reason: WorkerControllerDisconnectReason) => Promise<void>>,
): Promise<void> {
  await Promise.all([...listeners].map((listener) => listener("connectivity_lost")));
}
