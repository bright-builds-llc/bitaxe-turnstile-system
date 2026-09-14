import { exactSerialRecord, serialFailure } from "./worker-serial";

export const CADENCE_PHASES = ["idle", "usb", "mining"] as const;
export type WorkerCadencePhase = typeof CADENCE_PHASES[number];
const counters = ["maxProbeCount", "intervalCount", "cpuMismatchCount", "priorityMismatchCount", "subscriberMismatchCount", "projectionCount", "unchangedCount", "noSubscriberCount", "projectionFailures", "serializationFailures", "queueFailures", "sendFailures", "sendsQueued", "sendsCompleted", "pendingSends", "clockFailures"] as const;
const times = ["firstMaxProbeAtUs", "lastMaxProbeAtUs", "armedAtUs", "startedAtUs", "endedAtUs", "maximumIntervalUs", "maximumExecutionUs", "maximumLiveUs", "maximumLogsUs", "maximumPruneUs"] as const;
export type WorkerCadenceSummary = Record<typeof counters[number] | typeof times[number], number> & {
  phase: WorkerCadencePhase; state: "empty" | "armed" | "capturing" | "complete"; generation: number;
  intervalBuckets: [number, number, number, number]; overflow: boolean; passed: boolean;
};
export const CADENCE_LIVE_STAGES = ["visible_state", "platform", "health_safety", "confirmed_settings", "settings_transaction_wait", "settings_nvs_read", "wifi", "publication_order_wait", "projection_complete", "retention", "serialization_queue"] as const;
export type WorkerCadenceStageDurations = [number, number, number, number, number, number, number, number, number, number, number];
export type WorkerCadenceSummaryV2 = WorkerCadenceSummary & {
  maximumLiveStagesUs: WorkerCadenceStageDurations;
  worstInterval: { previousExecutionUs: number; previousLiveStagesUs: WorkerCadenceStageDurations; gapUs: number };
};
export type WorkerCadenceReview = {
  snapshotAvailable: boolean; droppedObservations: number; storageBytes: number;
} & (
  { schema: "worker-telemetry-cadence-v1"; phases: WorkerCadenceSummary[] } |
  { schema: "worker-telemetry-cadence-v2"; phases: WorkerCadenceSummaryV2[] }
);
export type WorkerCadenceArm = { schema: "worker-telemetry-cadence-arm-v1"; phase: WorkerCadencePhase; armedAtUs: number; generation: number };
/** Private transport input: never include this type in public state, traces or diagnostics. */
export type WorkerTelemetryEndpoint = { schema: "worker-telemetry-endpoint-v1"; ipv4: string; httpPort: number; observedAtUs: number; bootOrdinal: number; generation: number };

function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) throw serialFailure("fields");
  return Number(value);
}
export function parseWorkerCadencePhase(input: unknown): WorkerCadencePhase {
  if (typeof input !== "string" || !CADENCE_PHASES.includes(input as WorkerCadencePhase)) throw serialFailure("fields");
  return input as WorkerCadencePhase;
}
export function parseWorkerCadenceArm(input: unknown): WorkerCadenceArm {
  const value = exactSerialRecord(input, ["schema", "phase", "armedAtUs", "generation"]);
  if (value.schema !== "worker-telemetry-cadence-arm-v1") throw serialFailure("fields");
  return { schema: value.schema, phase: parseWorkerCadencePhase(value.phase), armedAtUs: integer(value.armedAtUs), generation: integer(value.generation, 0xffff_ffff) };
}
function stageDurations(input: unknown): WorkerCadenceStageDurations {
  if (!Array.isArray(input) || input.length !== CADENCE_LIVE_STAGES.length) throw serialFailure("fields");
  return Array.from(input, value => integer(value)) as WorkerCadenceStageDurations;
}
function summary(input: unknown, v2: true): WorkerCadenceSummaryV2;
function summary(input: unknown, v2: false): WorkerCadenceSummary;
function summary(input: unknown, v2: boolean): WorkerCadenceSummary | WorkerCadenceSummaryV2 {
  const value = exactSerialRecord(input, ["phase", "state", "generation", ...counters, ...times, "intervalBuckets", "overflow", "passed", ...(v2 ? ["maximumLiveStagesUs", "worstInterval"] : [])]);
  parseWorkerCadencePhase(value.phase);
  if (!["empty", "armed", "capturing", "complete"].includes(String(value.state)) || typeof value.overflow !== "boolean" || typeof value.passed !== "boolean") throw serialFailure("fields");
  integer(value.generation, 0xffff_ffff);
  for (const key of counters) integer(value[key], 0xffff_ffff);
  for (const key of times) integer(value[key]);
  if (!Array.isArray(value.intervalBuckets) || value.intervalBuckets.length !== 4) throw serialFailure("fields");
  for (const count of value.intervalBuckets) integer(count, 0xffff_ffff);
  if (value.intervalBuckets.reduce((sum, count) => sum + Number(count), 0) !== value.intervalCount) throw serialFailure("fields");
  if (value.passed && (value.state !== "complete" || value.overflow)) throw serialFailure("fields");
  const base = structuredClone(value) as WorkerCadenceSummary;
  if (!v2) return base;
  const worst = exactSerialRecord(value.worstInterval, ["previousExecutionUs", "previousLiveStagesUs", "gapUs"]);
  return { ...base, maximumLiveStagesUs: stageDurations(value.maximumLiveStagesUs),
    worstInterval: { previousExecutionUs: integer(worst.previousExecutionUs), previousLiveStagesUs: stageDurations(worst.previousLiveStagesUs), gapUs: integer(worst.gapUs) } };
}
/** Validate only the closed observation shape; the prospective supervisor judge owns acceptance. */
export function parseWorkerCadenceReview(input: unknown): WorkerCadenceReview {
  const value = exactSerialRecord(input, ["schema", "snapshotAvailable", "droppedObservations", "storageBytes", "phases"]);
  if ((value.schema !== "worker-telemetry-cadence-v1" && value.schema !== "worker-telemetry-cadence-v2") || typeof value.snapshotAvailable !== "boolean" || !Array.isArray(value.phases) || value.phases.length !== 3) throw serialFailure("fields");
  const common = { snapshotAvailable: value.snapshotAvailable, droppedObservations: integer(value.droppedObservations, 0xffff_ffff), storageBytes: integer(value.storageBytes, 0xffff_ffff) };
  const phaseInputs = value.phases;
  for (const [index, input] of phaseInputs.entries()) {
    if (input === null || typeof input !== "object" || input.phase !== CADENCE_PHASES[index]) throw serialFailure("fields");
  }
  if (value.schema === "worker-telemetry-cadence-v2") return { ...common, schema: value.schema, phases: phaseInputs.map(input => summary(input, true)) };
  return { ...common, schema: value.schema, phases: phaseInputs.map(input => summary(input, false)) };
}
export function parseWorkerTelemetryEndpoint(input: unknown): WorkerTelemetryEndpoint {
  const value = exactSerialRecord(input, ["schema", "ipv4", "httpPort", "observedAtUs", "bootOrdinal", "generation"]);
  if (value.schema !== "worker-telemetry-endpoint-v1" || typeof value.ipv4 !== "string" || !/^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}$/u.test(value.ipv4)) throw serialFailure("fields");
  const octets = value.ipv4.split(".").map(Number);
  if (octets.some(part => part > 255) || octets[0] === 0 || octets[0] === 127 || Number(octets[0]) >= 224) throw serialFailure("fields");
  const httpPort = integer(value.httpPort, 65535);
  if (!httpPort) throw serialFailure("fields");
  return { schema: value.schema, ipv4: value.ipv4, httpPort, observedAtUs: integer(value.observedAtUs), bootOrdinal: integer(value.bootOrdinal), generation: integer(value.generation, 0xffff_ffff) };
}
