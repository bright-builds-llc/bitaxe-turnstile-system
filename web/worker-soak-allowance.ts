import { decodeBase64Url, encodeBase64Url } from "./crypto-bytes";
import { exactSerialRecord, serialFailure } from "./worker-serial";

/**
 * Signed hardware profile and one-shot soak allowance (firmware ADR-0033). Upstream-default is valid only
 * with a soak allowance; firmware enforces this and the Gate refuses the same grants before delivery.
 */
export type WorkerHardwareProfile = "conservative" | "upstream-default";
/** 600,000 ms of admitted work plus the firmware's 15,550 ms pre-reset shutdown tail. */
export const SOAK_MAXIMUM_ACTIVE_MILLISECONDS = 615550;
export const SOAK_WORK_GATE_MILLISECONDS = 600000;
/** Soak leases may pre-sign more renewals than the general 16-artifact bound. */
export const SOAK_MAXIMUM_RENEWALS = 36;
export type WorkerSoakAllowance = { schema: "worker-soak-allowance-v1"; id: string; ordinal: number; maximumActiveMilliseconds: typeof SOAK_MAXIMUM_ACTIVE_MILLISECONDS };
export type WorkerSoakObservation = { schema: "worker-soak-observation-v1"; ordinal: number; maximum_active_ms: typeof SOAK_MAXIMUM_ACTIVE_MILLISECONDS; reserved_ms: number; complete: boolean; active_ms: number };
export type WorkerSoakLedger = { schema: "worker-soak-ledger-v1"; next_ordinal: number; total_charged_ms: number; pending: boolean; last_completed_ordinal: number };

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw serialFailure("fields");
  return value;
}

export function parseWorkerHardwareProfile(value: unknown): WorkerHardwareProfile {
  if (value !== "conservative" && value !== "upstream-default") throw new Error("Work Lease hardware profile is invalid");
  return value;
}

export function parseWorkerSoakAllowance(input: unknown): WorkerSoakAllowance {
  const value = exactSerialRecord(input, ["schema", "id", "ordinal", "maximumActiveMilliseconds"]);
  if (value.schema !== "worker-soak-allowance-v1" || typeof value.id !== "string") throw serialFailure("fields");
  const bytes = decodeBase64Url(value.id, 22, "fields");
  if (bytes.length !== 16 || encodeBase64Url(bytes) !== value.id) throw serialFailure("fields");
  if (value.maximumActiveMilliseconds !== SOAK_MAXIMUM_ACTIVE_MILLISECONDS) throw serialFailure("fields");
  return { schema: "worker-soak-allowance-v1", id: value.id, ordinal: integer(value.ordinal, 1, 0xffffffff), maximumActiveMilliseconds: SOAK_MAXIMUM_ACTIVE_MILLISECONDS };
}

export function parseWorkerSoakObservation(input: unknown): WorkerSoakObservation {
  const value = exactSerialRecord(input, ["schema", "ordinal", "maximum_active_ms", "reserved_ms", "complete", "active_ms"]);
  const limit = SOAK_MAXIMUM_ACTIVE_MILLISECONDS;
  if (value.schema !== "worker-soak-observation-v1" || value.maximum_active_ms !== limit || value.reserved_ms !== limit || typeof value.complete !== "boolean") throw serialFailure("fields");
  return { schema: "worker-soak-observation-v1", ordinal: integer(value.ordinal, 1, 0xffffffff), maximum_active_ms: limit, reserved_ms: limit, complete: value.complete, active_ms: integer(value.active_ms, 0, limit) };
}

export function parseWorkerSoakLedger(input: unknown): WorkerSoakLedger {
  const value = exactSerialRecord(input, ["schema", "next_ordinal", "total_charged_ms", "pending", "last_completed_ordinal"]);
  if (value.schema !== "worker-soak-ledger-v1" || typeof value.pending !== "boolean") throw serialFailure("fields");
  const next = integer(value.next_ordinal, 1, 0x100000000);
  const completed = integer(value.last_completed_ordinal, 0, 0xffffffff);
  if (completed >= next || completed !== next - (value.pending ? 2 : 1)) throw serialFailure("fields");
  const total = integer(value.total_charged_ms, 0, Number.MAX_SAFE_INTEGER);
  if (total !== (next - 1) * SOAK_MAXIMUM_ACTIVE_MILLISECONDS) throw serialFailure("fields");
  return { schema: "worker-soak-ledger-v1", next_ordinal: next, total_charged_ms: total, pending: value.pending, last_completed_ordinal: completed };
}

/** Grant-level soak rules, identical to firmware `WorkerLeaseGrant::valid_soak_shape`. */
export function validSoakShape(grant: {
  hardwareProfile?: WorkerHardwareProfile;
  soakAllowance?: WorkerSoakAllowance;
  durationMilliseconds: number;
  renewAfterMilliseconds: number;
  isV2: boolean;
}): boolean {
  if (grant.soakAllowance === undefined) return grant.hardwareProfile !== "upstream-default";
  return grant.hardwareProfile !== undefined && !grant.isV2 && grant.durationMilliseconds === 60000 && grant.renewAfterMilliseconds === 20000;
}
