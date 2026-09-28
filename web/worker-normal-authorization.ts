import type { WorkerAuthorizationRecoveryCheckpoint } from "./worker-authorization-recovery";

/** Observe only the private status delivered by this acknowledged authorization operation. */
export async function runWorkerNormalAuthorization<T>(checkpoint: WorkerAuthorizationRecoveryCheckpoint, enabled: boolean,
  operation: () => Promise<T>, cleanup: () => Promise<unknown>): Promise<T> {
  if (!enabled) return operation();
  try {
    const token = checkpoint.beginAuthorizedOperation();
    const result = await operation(); checkpoint.completeAuthorizedOperation(token); return result;
  } catch (error) {
    checkpoint.cancelAuthorizedOperation();
    try { await cleanup(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Authorization observation and cleanup failed"); }
    throw error;
  }
}
