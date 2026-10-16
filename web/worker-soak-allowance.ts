import { decodeBase64Url, encodeBase64Url } from "./crypto-bytes";
import { exactSerialRecord, serialFailure } from "./worker-serial";

/**
 * One-shot soak allowance (firmware ADR-0033). Since firmware ADR-0037 the grant carries no hardware
 * profile: the device's own settings choose it. The budget is mining time; the ordered shutdown runs after
 * it, outside the budget, so v2 allowances and ledgers replace v1 and charge exactly 600,000 ms.
 */
export const SOAK_MAXIMUM_ACTIVE_MILLISECONDS = 600000;
/** Soak leases may pre-sign more renewals than the general 16-artifact bound. */
export const SOAK_MAXIMUM_RENEWALS = 36;
export type WorkerSoakAllowance = { schema: "worker-soak-allowance-v2"; id: string; ordinal: number; maximumActiveMilliseconds: typeof SOAK_MAXIMUM_ACTIVE_MILLISECONDS };
/** The firmware keeps the live observation's schema name; only its limit changed to 600,000 ms. */
export type WorkerSoakObservation = { schema: "worker-soak-observation-v1"; ordinal: number; maximum_active_ms: typeof SOAK_MAXIMUM_ACTIVE_MILLISECONDS; reserved_ms: number; complete: boolean; active_ms: number };
export type WorkerSoakLedger = { schema: "worker-soak-ledger-v2"; next_ordinal: number; total_charged_ms: number; pending: boolean; last_completed_ordinal: number };

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw serialFailure("fields");
  return value;
}

export function parseWorkerSoakAllowance(input: unknown): WorkerSoakAllowance {
  const value = exactSerialRecord(input, ["schema", "id", "ordinal", "maximumActiveMilliseconds"]);
  if (value.schema !== "worker-soak-allowance-v2" || typeof value.id !== "string") throw serialFailure("fields");
  const bytes = decodeBase64Url(value.id, 22, "fields");
  if (bytes.length !== 16 || encodeBase64Url(bytes) !== value.id) throw serialFailure("fields");
  if (value.maximumActiveMilliseconds !== SOAK_MAXIMUM_ACTIVE_MILLISECONDS) throw serialFailure("fields");
  return { schema: "worker-soak-allowance-v2", id: value.id, ordinal: integer(value.ordinal, 1, 0xffffffff), maximumActiveMilliseconds: SOAK_MAXIMUM_ACTIVE_MILLISECONDS };
}

export function parseWorkerSoakObservation(input: unknown): WorkerSoakObservation {
  const value = exactSerialRecord(input, ["schema", "ordinal", "maximum_active_ms", "reserved_ms", "complete", "active_ms"]);
  const limit = SOAK_MAXIMUM_ACTIVE_MILLISECONDS;
  if (value.schema !== "worker-soak-observation-v1" || value.maximum_active_ms !== limit || value.reserved_ms !== limit || typeof value.complete !== "boolean") throw serialFailure("fields");
  return { schema: "worker-soak-observation-v1", ordinal: integer(value.ordinal, 1, 0xffffffff), maximum_active_ms: limit, reserved_ms: limit, complete: value.complete, active_ms: integer(value.active_ms, 0, limit) };
}

/** The v2 ledger starts fresh at ordinal 1; every charged ordinal costs exactly 600,000 ms. */
export function parseWorkerSoakLedger(input: unknown): WorkerSoakLedger {
  const value = exactSerialRecord(input, ["schema", "next_ordinal", "total_charged_ms", "pending", "last_completed_ordinal"]);
  if (value.schema !== "worker-soak-ledger-v2" || typeof value.pending !== "boolean") throw serialFailure("fields");
  const next = integer(value.next_ordinal, 1, 0x100000000);
  const completed = integer(value.last_completed_ordinal, 0, 0xffffffff);
  if (completed >= next || completed !== next - (value.pending ? 2 : 1)) throw serialFailure("fields");
  const total = integer(value.total_charged_ms, 0, Number.MAX_SAFE_INTEGER);
  if (total !== (next - 1) * SOAK_MAXIMUM_ACTIVE_MILLISECONDS) throw serialFailure("fields");
  return { schema: "worker-soak-ledger-v2", next_ordinal: next, total_charged_ms: total, pending: value.pending, last_completed_ordinal: completed };
}

/** Grant-level soak rules, identical to firmware `WorkerLeaseGrant::valid_soak_shape`. */
export function validSoakShape(grant: {
  soakAllowance?: WorkerSoakAllowance;
  durationMilliseconds: number;
  renewAfterMilliseconds: number;
  isV2: boolean;
}): boolean {
  if (grant.soakAllowance === undefined) return true;
  return !grant.isV2 && grant.durationMilliseconds === 60000 && grant.renewAfterMilliseconds === 20000;
}
