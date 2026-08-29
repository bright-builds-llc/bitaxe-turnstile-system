import type { WorkerControllerDisconnectReason } from "./worker-controller";

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

/** Notifies every registered listener and fails if any restoration listener fails. */
export async function notifyWorkerDisconnect(
  listeners: ReadonlySet<(reason: WorkerControllerDisconnectReason) => Promise<void>>,
): Promise<void> {
  await Promise.all([...listeners].map((listener) => listener("connectivity_lost")));
}
