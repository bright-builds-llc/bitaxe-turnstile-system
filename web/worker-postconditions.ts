import type { WorkerControllerStatus } from "./worker-controller";
import type { WorkerRestorationReason } from "./worker-controller";


export type WorkerMiningPostcondition = {
  leaseId: string;
  challengeId: string;
  durationMilliseconds: number;
  renewAfterMilliseconds: number;
};

/** Pure command-result check used before the browser adapter reports active work. */
export function workerMiningStatusMatches(
  status: WorkerControllerStatus,
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
  status: WorkerControllerStatus,
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
