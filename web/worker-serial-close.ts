/** Preserve the primary wire failure while always awaiting owned native cleanup. */
export async function finishWorkerSerialClose(operations: {
  interrupted: boolean; restore: boolean; closeSession(): boolean;
  revokeRecord(): void; restoreBaseline(): Promise<unknown>; stopHeartbeats(): void;
  sendClose(): Promise<void>; cleanup(): Promise<void>;
}): Promise<void> {
  let maybeError: unknown;
  if (operations.interrupted) operations.revokeRecord();
  try {
    if (operations.restore) await operations.restoreBaseline();
    operations.stopHeartbeats();
    if (operations.closeSession()) await operations.sendClose();
  } catch (error) { maybeError = error; }
  try { await operations.cleanup(); }
  catch (error) { maybeError = maybeError ? new AggregateError([maybeError, error], "Worker Serial close failed") : error; }
  if (maybeError) throw maybeError;
}
