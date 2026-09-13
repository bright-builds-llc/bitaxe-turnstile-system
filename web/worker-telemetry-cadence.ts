import { exactSerialRecord, serialFailure } from "./worker-serial";

export const CADENCE_PHASES = ["idle", "usb", "mining"] as const;
export type WorkerCadencePhase = typeof CADENCE_PHASES[number];
const counters = ["maxProbeCount", "intervalCount", "cpuMismatchCount", "priorityMismatchCount", "subscriberMismatchCount", "projectionCount", "unchangedCount", "noSubscriberCount", "projectionFailures", "serializationFailures", "queueFailures", "sendFailures", "sendsQueued", "sendsCompleted", "pendingSends", "clockFailures"] as const;
const times = ["firstMaxProbeAtUs", "lastMaxProbeAtUs", "armedAtUs", "startedAtUs", "endedAtUs", "maximumIntervalUs", "maximumExecutionUs", "maximumLiveUs", "maximumLogsUs", "maximumPruneUs"] as const;
export type WorkerCadenceSummary = Record<typeof counters[number] | typeof times[number], number> & {
  phase: WorkerCadencePhase; state: "empty" | "armed" | "capturing" | "complete"; generation: number;
  intervalBuckets: [number, number, number, number]; overflow: boolean; passed: boolean;
};
export type WorkerCadenceReview = {
  schema: "worker-telemetry-cadence-v1"; snapshotAvailable: boolean; droppedObservations: number;
  storageBytes: number; phases: WorkerCadenceSummary[];
};
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
function summary(input: unknown): WorkerCadenceSummary {
  const value = exactSerialRecord(input, ["phase", "state", "generation", ...counters, ...times, "intervalBuckets", "overflow", "passed"]);
  parseWorkerCadencePhase(value.phase);
  if (!["empty", "armed", "capturing", "complete"].includes(String(value.state)) || typeof value.overflow !== "boolean" || typeof value.passed !== "boolean") throw serialFailure("fields");
  integer(value.generation, 0xffff_ffff);
  for (const key of counters) integer(value[key], 0xffff_ffff);
  for (const key of times) integer(value[key]);
  if (!Array.isArray(value.intervalBuckets) || value.intervalBuckets.length !== 4) throw serialFailure("fields");
  for (const count of value.intervalBuckets) integer(count, 0xffff_ffff);
  if (value.intervalBuckets.reduce((sum, count) => sum + Number(count), 0) !== value.intervalCount) throw serialFailure("fields");
  if (value.passed && (value.state !== "complete" || value.overflow)) throw serialFailure("fields");
  return structuredClone(value) as WorkerCadenceSummary;
}
/** Validate only the closed observation shape; the prospective supervisor judge owns acceptance. */
export function parseWorkerCadenceReview(input: unknown): WorkerCadenceReview {
  const value = exactSerialRecord(input, ["schema", "snapshotAvailable", "droppedObservations", "storageBytes", "phases"]);
  if (value.schema !== "worker-telemetry-cadence-v1" || typeof value.snapshotAvailable !== "boolean" || !Array.isArray(value.phases) || value.phases.length !== 3) throw serialFailure("fields");
  const phases = value.phases.map(summary);
  if (phases.some((phase, index) => phase.phase !== CADENCE_PHASES[index])) throw serialFailure("fields");
  return { schema: value.schema, snapshotAvailable: value.snapshotAvailable, droppedObservations: integer(value.droppedObservations, 0xffff_ffff), storageBytes: integer(value.storageBytes, 0xffff_ffff), phases };
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
