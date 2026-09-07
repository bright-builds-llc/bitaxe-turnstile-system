import type { WorkerSerialDiagnostic } from "./worker-serial-diagnostics";
const invalid = /^worker_preparation_receipt schema=v1 origin=(current_boot|previous_boot) status=(incomplete|corrupt|unavailable|wrong_firmware) redacted=true$/u;
const valid = /^worker_preparation_receipt schema=v1 origin=(current_boot|previous_boot) status=valid interrupted=(true|false) source_hash=([0-9a-f]{16}) boot_ordinal=(\d{1,20}) generation=(\d{1,10}) sequence=(\d{1,10}) uptime_ms=(\d{1,20}) last_completed_step=([0-9]) current_step=([1-9]) outcome=(started|completed|failed) failure=(none|cancelled|safety_unavailable|owner_unavailable|queue_full|reply_timeout|hardware_write_failed|fan_timeout|unsupported_profile|asic_failed|asic_plan_invalid|cooling_timeout|cooling_proof_required) heap_free=(\d{1,10}|unavailable) heap_largest=(\d{1,10}|unavailable) stack_free=(\d{1,10}|unavailable) redacted=true$/u;
const fields = ["origin", "interrupted", "source_hash", "boot_ordinal", "generation", "sequence", "uptime_ms", "last_completed_step", "current_step", "outcome", "failure", "heap_free", "heap_largest", "stack_free"];
export function maybePreparationDiagnostic(line: string): WorkerSerialDiagnostic | undefined {
  const unavailable = invalid.exec(line);
  if (unavailable && unavailable[0].length === line.length) return { category: "worker_preparation_receipt", authoritative: false, origin: unavailable[1]!, status: unavailable[2]! };
  const match = valid.exec(line);
  if (!match || match[0].length !== line.length) return undefined;
  const result: Record<string, string | number | boolean> = { category: "worker_preparation_receipt", authoritative: false, status: "valid" };
  for (const [index, field] of fields.entries()) {
    const text = match[index + 1]!;
    if (["origin", "interrupted", "source_hash", "outcome", "failure"].includes(field) || text === "unavailable") { result[field] = text; continue; }
    // Preserve u64 counters as decimal strings rather than silently rounding them.
    if (["boot_ordinal", "uptime_ms"].includes(field)) {
      if (BigInt(text) > 18446744073709551615n) return undefined;
      result[field] = text;
      continue;
    }
    const value = Number(text);
    if (value > 0xffffffff) return undefined;
    result[field] = value;
  }
  const completed = Number(result.last_completed_step), current = Number(result.current_step);
  if ((result.outcome === "started" && completed >= current) ||
      (result.outcome === "completed" && completed !== current) ||
      (result.outcome === "failed" && completed > current)) return undefined;
  if ((result.outcome === "failed") !== (result.failure !== "none")) return undefined;
  return Object.freeze(result);
}
export function maybePreparationExport(input: WorkerSerialDiagnostic): WorkerSerialDiagnostic | undefined {
  if (input.category !== "worker_preparation_receipt") return undefined;
  const suffix = input.status === "valid" ? ` interrupted=${input.interrupted} source_hash=${input.source_hash} boot_ordinal=${input.boot_ordinal} generation=${input.generation} sequence=${input.sequence} uptime_ms=${input.uptime_ms} last_completed_step=${input.last_completed_step} current_step=${input.current_step} outcome=${input.outcome} failure=${input.failure} heap_free=${input.heap_free} heap_largest=${input.heap_largest} stack_free=${input.stack_free}` : "";
  const parsed = maybePreparationDiagnostic(`worker_preparation_receipt schema=v1 origin=${input.origin} status=${input.status}${suffix} redacted=true`);
  return parsed && sameRecord(input, parsed) ? parsed : undefined;
}
export function sameRecord(left: WorkerSerialDiagnostic, right: WorkerSerialDiagnostic): boolean {
  return Object.keys(left).length === Object.keys(right).length && Object.entries(right).every(([key, value]) => left[key] === value);
}
