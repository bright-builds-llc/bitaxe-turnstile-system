const observableCategories = [
  "timeout", "io", "read_failed", "write_failed", "disconnected", "liveness_lost",
  "wire_bound", "payload_bound", "utf8", "line_ending", "profile", "shape", "fields",
  "envelope", "session", "continuity", "heartbeat", "sequence_exhausted", "correlation",
  "command_rejected", "closed", "operation_failed",
] as const;
export type WorkerSerialFailureCategory = typeof observableCategories[number];

class SerialFailure extends Error {
  constructor(readonly category: string) { super(`Worker Serial ${category}`); }
}
export function serialFailure(category: string): Error { return new SerialFailure(category); }
/** Keeps local typed protocol failures; external errors get a fixed transport category. */
export function serialFailureFor(error: unknown, fallback: string): Error {
  return error instanceof SerialFailure ? error : serialFailure(fallback);
}
/** Never projects arbitrary exception text or caller-controlled fields. */
export function workerSerialFailureCategory(error: unknown): WorkerSerialFailureCategory {
  if (error instanceof SerialFailure) {
    const maybeCategory = observableCategories.find(category => category === error.category);
    if (maybeCategory) return maybeCategory;
  }
  return "operation_failed";
}
