import { SerialFailure } from "./worker-serial-errors";
import { WORKER_CONTROLLER_PROTOCOL_VERSION } from "./worker-controller";
import { exactSerialRecord, serialFailure } from "./worker-serial";
const categories = new Set([
  "invalid_frame", "invalid_request", "admission_required", "invalid_proof",
  "authentication_failed", "invalid_transition", "persistence_failed", "monotonic_reset",
  "session_failed", "restoration_pending", "stale_response", "encoding_failed",
]);
class WorkerControlRejection extends SerialFailure {
  constructor(readonly rejection: string) { super("command_rejected"); }
}
/** Identifies only a parsed closed firmware rejection, never arbitrary exception text. */
export function isWorkerRestorationPending(error: unknown): boolean {
  return error instanceof WorkerControlRejection && error.rejection === "restoration_pending";
}
/** Only firmware's closed rejection vocabulary can become an observation. */
export function parseWorkerControlRejection(input: unknown): string {
  const error = exactSerialRecord(input, ["code", "message"]);
  if (error.code !== "command_rejected" || typeof error.message !== "string" || !categories.has(error.message)) throw serialFailure("fields");
  return error.message;
}

/** Parses an already-correlated result without exposing arbitrary rejection text. */
export function parseWorkerControlResult(response: unknown, maybeObserveRejection?: (category: string) => void): unknown {
  const value = exactSerialRecord(response,
    response && typeof response === "object" && "ok" in response && response.ok === true
      ? ["protocolVersion", "requestId", "ok", "result"]
      : ["protocolVersion", "requestId", "ok", "error"]);
  if (value.protocolVersion !== WORKER_CONTROLLER_PROTOCOL_VERSION) throw serialFailure("fields");
  if (value.ok === true) return value.result;
  const category = parseWorkerControlRejection(value.error);
  maybeObserveRejection?.(category);
  throw new WorkerControlRejection(category);
}
