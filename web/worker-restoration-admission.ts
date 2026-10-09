import type { WorkerSerialDiagnostic } from "./worker-serial-diagnostics";

/** Closed values exactly as the firmware's periodic `worker_admission schema=v1` diagnostic enumerates them. */
export const WORKER_ADMISSION_STAGES = ["idle", "admission", "readiness", "preparation", "pool_activation", "active", "cleanup", "complete"] as const;
export const WORKER_ADMISSION_FAILURES = ["none", "admission", "readiness", "preparation", "pool_activation", "cleanup"] as const;
export type WorkerRestorationAdmission = {
  stage: typeof WORKER_ADMISSION_STAGES[number];
  firstFailure: typeof WORKER_ADMISSION_FAILURES[number];
  readiness: number;
};

/**
 * Projects a parsed `worker_admission` diagnostic without its budget fields. Non-authoritative: it explains a
 * device stage for evidence and never admits, gates or ends any Gate transition.
 */
export function maybeRestorationAdmission(value: WorkerSerialDiagnostic): WorkerRestorationAdmission | undefined {
  if (value.category !== "worker_admission") return undefined;
  const stage = WORKER_ADMISSION_STAGES.find(candidate => candidate === value.stage);
  const firstFailure = WORKER_ADMISSION_FAILURES.find(candidate => candidate === value.first_failure);
  const readiness = value.readiness;
  if (!stage || !firstFailure || typeof readiness !== "number" || !Number.isSafeInteger(readiness) || readiness < 0 || readiness > 63) return undefined;
  return { stage, firstFailure, readiness };
}
