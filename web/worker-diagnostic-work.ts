import type { WorkerQualification } from "./worker-qualification";

/** Stops the diagnostic once its initial work has yielded the available discriminator. */
export function diagnosticInitialWorkCaptured(
  maybeQualification: Pick<WorkerQualification, "generation" | "work_dispatched" | "mining_progress"> | undefined,
): boolean {
  if (!maybeQualification || maybeQualification.work_dispatched === 0) return false;
  const maybeProgress = maybeQualification.mining_progress;
  if (!maybeProgress || maybeProgress.generation !== maybeQualification.generation) return false;
  if (maybeProgress.schema === "worker-mining-progress-v1") return true;
  return BigInt(maybeProgress.expected_filter_matches) > 0n || BigInt(maybeProgress.expected_filter_misses) > 0n;
}
