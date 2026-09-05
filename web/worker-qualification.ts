import { exactSerialRecord, serialFailure } from "./worker-serial";

/** Closed, read-only device evidence; never authority to Start or extend a lease. */
export type WorkerQualification = {
  schema: "worker-qualification-v1";
  generation: number;
  active_ms: number;
  generation_elapsed_ms: number;
  budget_reserved_ms: number;
  budget_complete: boolean;
  submitted: number;
  accepted: number;
  rejected: number;
  nonce_work_correlations: number;
  work_dispatched: number;
  last_valid_heartbeat_ms: number;
  gate_closed_ms: number | null;
  shutdown_started_ms: number | null;
  safe_stop_stage:
    | "not_started"
    | "stop_dispatch"
    | "reduce_frequency_and_reset_nonce"
    | "hold_reset_low"
    | "disable_core_voltage"
    | "disable_asic"
    | "fan_full"
    | "cooling_proof"
    | "fan_paused";
  safe_stop_complete: boolean;
  voltage_volts: number | null;
  power_watts: number | null;
  chip_temp_celsius: number | null;
  fan_rpm: number | null;
  voltage_fresh: boolean;
  power_fresh: boolean;
  temperature_fresh: boolean;
  fan_fresh: boolean;
  watchdog_alive: boolean;
  mine_on_boot: boolean;
};
const counters = [
  "generation",
  "active_ms",
  "generation_elapsed_ms",
  "budget_reserved_ms",
  "submitted",
  "accepted",
  "rejected",
  "nonce_work_correlations",
  "work_dispatched",
  "last_valid_heartbeat_ms",
] as const;
const timestamps = ["gate_closed_ms", "shutdown_started_ms"] as const;
const flags = [
  "budget_complete",
  "safe_stop_complete",
  "voltage_fresh",
  "power_fresh",
  "temperature_fresh",
  "fan_fresh",
  "watchdog_alive",
  "mine_on_boot",
] as const;
const samples = [
  "voltage_volts",
  "power_watts",
  "chip_temp_celsius",
  "fan_rpm",
] as const;
/** Requires every known field and rejects arbitrary extensions, NaN, and inconsistent freshness. */
export function parseWorkerQualification(input: unknown): WorkerQualification {
  const value = exactSerialRecord(input, [
    "schema",
    ...counters,
    ...timestamps,
    "safe_stop_stage",
    ...flags,
    ...samples,
  ]);
  if (value.schema !== "worker-qualification-v1")
    throw serialFailure("qualification_schema");
  for (const field of counters)
    if (!u32(value[field])) throw serialFailure("qualification_counter");
  if (Number(value.budget_reserved_ms) > 240000)
    throw serialFailure("qualification_budget");
  for (const field of timestamps)
    if (value[field] !== null && !u32(value[field]))
      throw serialFailure("qualification_time");
  for (const field of flags)
    if (typeof value[field] !== "boolean")
      throw serialFailure("qualification_flag");
  for (const field of samples)
    if (
      value[field] !== null &&
      (typeof value[field] !== "number" || !Number.isFinite(value[field]))
    )
      throw serialFailure("qualification_sample");
  if (
    value.fan_rpm !== null &&
    (!u32(value.fan_rpm) || Number(value.fan_rpm) > 65535)
  )
    throw serialFailure("qualification_rpm");
  for (const [sample, flag] of [
    ["voltage_volts", "voltage_fresh"],
    ["power_watts", "power_fresh"],
    ["chip_temp_celsius", "temperature_fresh"],
    ["fan_rpm", "fan_fresh"],
  ] as const)
    if ((value[sample] !== null) !== value[flag])
      throw serialFailure("qualification_freshness");
  if (
    ![
      "not_started",
      "stop_dispatch",
      "reduce_frequency_and_reset_nonce",
      "hold_reset_low",
      "disable_core_voltage",
      "disable_asic",
      "fan_full",
      "cooling_proof",
      "fan_paused",
    ].includes(String(value.safe_stop_stage))
  )
    throw serialFailure("qualification_stage");
  return value as WorkerQualification;
}
function u32(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0xffff_ffff
  );
}
