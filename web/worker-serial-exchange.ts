import { boundedSerial, observeSerialOutcome, type WorkerSerialBrowserRuntime } from "./webserial-worker-port";
import { serialFailure, serialFailureFor } from "./worker-serial";

/** Observes consumption before response settlement while retaining ordinary failure cleanup. */
export async function runWorkerSerialExchange(operations: {
  response: Promise<unknown>;
  send(): Promise<void>;
  maybeAfterConsumed: (() => Promise<void>) | undefined;
  current(): boolean;
  failed(error: Error): void;
  clear(): void;
  timeoutMilliseconds: number;
  maybeAfter: WorkerSerialBrowserRuntime["maybeAfter"];
}): Promise<unknown> {
  const outcome = observeSerialOutcome(operations.response);
  try {
    await operations.send();
    if (operations.maybeAfterConsumed) await operations.maybeAfterConsumed();
    const result = await boundedSerial(outcome, operations.timeoutMilliseconds, operations.maybeAfter);
    if (!result.ok) throw result.error;
    if (!operations.current()) throw serialFailure("stale_response");
    return result.value;
  } catch (error) {
    operations.failed(serialFailureFor(error, "request_failed"));
    throw error;
  } finally {
    operations.clear();
  }
}
