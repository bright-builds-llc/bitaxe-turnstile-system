import { decodeBase64Url, encodeBase64Url } from "./crypto-bytes";
import { exactSerialRecord, serialFailure } from "./worker-serial";
export type QualificationAttemptPurpose = "diagnostic" | "normal" | "foreground_loss" | "heartbeat_loss";
export type WorkerQualificationAttempt = { schema: "worker-qualification-attempt-v1"; id: string; ordinal: number; purpose: QualificationAttemptPurpose; maximumActiveMilliseconds: 180000 | 30000 };
export type WorkerQualificationObservation = { schema: "worker-qualification-observation-v1"; ordinal: number; purpose: QualificationAttemptPurpose; maximum_active_ms: 180000 | 30000; reserved_ms: number; complete: boolean; active_ms: number };
export type WorkerQualificationLedger = { schema: "worker-qualification-ledger-v1"; next_ordinal: number; total_charged_ms: number; pending: boolean; last_completed_ordinal: number };
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw serialFailure("fields");
  return value;
}
function purpose(value: unknown): QualificationAttemptPurpose {
  if (value !== "diagnostic" && value !== "normal" && value !== "foreground_loss" && value !== "heartbeat_loss") throw serialFailure("fields");
  return value;
}
export function parseWorkerQualificationAttempt(input: unknown): WorkerQualificationAttempt {
  const value = exactSerialRecord(input, ["schema", "id", "ordinal", "purpose", "maximumActiveMilliseconds"]);
  if (value.schema !== "worker-qualification-attempt-v1" || typeof value.id !== "string") throw serialFailure("fields");
  const bytes = decodeBase64Url(value.id, 22, "fields");
  if (bytes.length !== 16 || encodeBase64Url(bytes) !== value.id) throw serialFailure("fields");
  const admittedPurpose = purpose(value.purpose);
  const limit = admittedPurpose === "normal" ? 180000 : 30000;
  if (value.maximumActiveMilliseconds !== limit) throw serialFailure("fields");
  return { schema: "worker-qualification-attempt-v1", id: value.id, ordinal: integer(value.ordinal, 1, 0xffffffff), purpose: admittedPurpose, maximumActiveMilliseconds: limit };
}
export function parseWorkerQualificationObservation(input: unknown): WorkerQualificationObservation {
  const value = exactSerialRecord(input, ["schema", "ordinal", "purpose", "maximum_active_ms", "reserved_ms", "complete", "active_ms"]);
  const admittedPurpose = purpose(value.purpose);
  const limit = admittedPurpose === "normal" ? 180000 : 30000;
  if (value.schema !== "worker-qualification-observation-v1" || value.maximum_active_ms !== limit || value.reserved_ms !== limit || typeof value.complete !== "boolean") throw serialFailure("fields");
  return { schema: "worker-qualification-observation-v1", ordinal: integer(value.ordinal, 1, 0xffffffff), purpose: admittedPurpose, maximum_active_ms: limit, reserved_ms: integer(value.reserved_ms, 0, limit), complete: value.complete, active_ms: integer(value.active_ms, 0, limit) };
}
export function parseWorkerQualificationLedger(input: unknown): WorkerQualificationLedger {
  const value = exactSerialRecord(input, ["schema", "next_ordinal", "total_charged_ms", "pending", "last_completed_ordinal"]);
  if (value.schema !== "worker-qualification-ledger-v1" || typeof value.pending !== "boolean") throw serialFailure("fields");
  const next = integer(value.next_ordinal, 1, 0x100000000);
  const completed = integer(value.last_completed_ordinal, 0, 0xffffffff);
  if (completed >= next || completed !== next - (value.pending ? 2 : 1)) throw serialFailure("fields");
  return { schema: "worker-qualification-ledger-v1", next_ordinal: next, total_charged_ms: integer(value.total_charged_ms, 0, Number.MAX_SAFE_INTEGER), pending: value.pending, last_completed_ordinal: completed };
}
