import type { WorkerControllerStatusV03 } from "./worker-controller-v03";
import type { WorkerRestorationReason } from "./worker-controller";
import {
  releaseAndCloseWorkerWebUsbDeviceStrict,
  type WorkerWebUsbDevice,
} from "./webusb-worker-port";

export type WorkerMiningPostcondition = {
  leaseId: string;
  challengeId: string;
  durationMilliseconds: number;
  renewAfterMilliseconds: number;
};

/** Pure command-result check used before the browser adapter reports active work. */
export function workerMiningStatusMatches(
  status: WorkerControllerStatusV03,
  expected: WorkerMiningPostcondition,
): boolean {
  return status.state === "mining" &&
    status.lease.leaseId === expected.leaseId &&
    status.lease.challengeId === expected.challengeId &&
    status.lease.renewAtMonotonicMilliseconds - status.monotonicMilliseconds ===
      expected.renewAfterMilliseconds &&
    status.lease.expiresAtMonotonicMilliseconds - status.monotonicMilliseconds ===
      expected.durationMilliseconds;
}

/** Pure command-result check used before the browser adapter reports restoration. */
export function workerRestoredStatusMatches(
  status: WorkerControllerStatusV03,
  reason: WorkerRestorationReason,
): boolean {
  return status.state === "baseline" &&
    status.restoration.status === "confirmed" &&
    status.restoration.reason === reason;
}

/** Accepts a persisted reboot as the stronger explanation for lost enumeration continuity. */
export function workerReacquisitionRestorationMatches(
  actual: WorkerRestorationReason,
  required: WorkerRestorationReason | undefined,
): boolean {
  return actual === required ||
    (required === "connectivity_lost" && actual === "reboot");
}

/** Closes an untrusted transport while preserving both semantic and cleanup failures. */
export async function closeWorkerAfterPostconditionFailure(
  device: WorkerWebUsbDevice,
  message: string,
): Promise<void> {
  try {
    await releaseAndCloseWorkerWebUsbDeviceStrict(device);
  } catch (cleanupError) {
    throw new AggregateError(
      [new Error(message), cleanupError],
      `${message}; Worker WebUSB cleanup failed`,
    );
  }
}
