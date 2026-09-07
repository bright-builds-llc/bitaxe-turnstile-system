import { exactSerialRecord, serialFailure } from "./worker-serial";
import type { WorkerQualification } from "./worker-qualification";
import type { WorkerLeaseGrant } from "./worker-controller";
export type WorkerOwnerResources = {
  schema: "worker-owner-resources-v1";
  generation: number;
  phase: "preparation" | "active" | "shutdown_complete";
  observed_at_ms: string;
  heap_free_bytes: number;
  heap_largest_bytes: number;
  stack_free_bytes: number;
};
/** Resource observations never authorize work and never expose arbitrary diagnostic text. */
export function parseWorkerOwnerResources(input: unknown, generation: number): WorkerOwnerResources {
  const value = exactSerialRecord(input, ["schema", "generation", "phase", "observed_at_ms", "heap_free_bytes", "heap_largest_bytes", "stack_free_bytes"]);
  if (value.schema !== "worker-owner-resources-v1" || value.generation !== generation || typeof value.phase !== "string" || !["preparation", "active", "shutdown_complete"].includes(String(value.phase))) throw serialFailure("fields");
  if (typeof value.observed_at_ms !== "string" || !/^(0|[1-9][0-9]{0,19})$/u.test(value.observed_at_ms) || BigInt(value.observed_at_ms) > 18446744073709551615n) throw serialFailure("fields");
  for (const field of ["generation", "heap_free_bytes", "heap_largest_bytes", "stack_free_bytes"]) {
    const counter = value[field];
    if (typeof counter !== "number" || !Number.isInteger(counter) || counter < 0 || counter > 0xffffffff) throw serialFailure("fields");
  }
  return value as WorkerOwnerResources;
}
/** Applies only to the new iterative campaign, never the immutable legacy campaign. */
export function requireWorkerOwnerHeadroom(grant: WorkerLeaseGrant, maybeQualification: WorkerQualification | undefined): void {
  if (!grant.qualificationAttempt) return;
  const maybeResources = maybeQualification?.owner_resources;
  if (!maybeResources || maybeResources.generation !== maybeQualification.generation || maybeResources.phase !== "active" || maybeResources.stack_free_bytes < 4096) throw new Error("window_control_failed");
}


export type WorkerOwnerResourceFailure = { schema: "worker-owner-resource-failure-v1"; generation: number | null; resources: WorkerOwnerResources | null };
/** Retains only the already-validated observation that caused qualification to stop. */
export function workerOwnerResourceFailure(maybeQualification: WorkerQualification | undefined): WorkerOwnerResourceFailure {
  const resources = maybeQualification?.owner_resources ? Object.freeze(structuredClone(maybeQualification.owner_resources)) : null;
  return Object.freeze({ schema: "worker-owner-resource-failure-v1", generation: maybeQualification?.generation ?? null, resources });
}
