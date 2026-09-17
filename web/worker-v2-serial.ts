import { exactSerialRecord, serialFailure } from "./worker-serial";
import { noiseUInt as uint, maybeNoiseUInt as nullableUInt, noiseEnum as choice, noiseBoolean as boolean, noiseAttemptId as nonce, noiseDigest as digest, noisePrivateIpv4 as ipv4, noisePort as port } from "./worker-noise-diagnostic-values";
import { parseWorkerV2Stratum } from "./worker-v2-stratum";
import { V2_STAGES, V2_OPERATIONS, V2_FAILURES, type ChannelStart, type V2Status, type DeviceRecord, type SocketTuple, type Event, type Timing, type ShareFact, type Failure, type Resources } from "./worker-v2-serial.types";
export type * from "./worker-v2-serial.types";
const fail = () => { throw serialFailure("v2_evidence_invalid"); };
function numbers<K extends string>(value: Record<string, unknown>, keys: readonly K[]): Record<K, number> { return Object.fromEntries(keys.map(key => [key, uint(value[key])])) as Record<K, number>; }
function nullableNumbers<K extends string>(value: Record<string, unknown>, keys: readonly K[]): Record<K, number | null> { return Object.fromEntries(keys.map(key => [key, nullableUInt(value[key])])) as Record<K, number | null>; }
function array<T>(input: unknown, max: number, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(input) || input.length > max) return fail();
  return input.map(parse);
}
function socket(input: unknown): SocketTuple {
  const v = exactSerialRecord(input, ["localIpv4", "localPort", "remoteIpv4", "remotePort"]);
  return { localIpv4: ipv4(v.localIpv4), localPort: port(v.localPort), remoteIpv4: ipv4(v.remoteIpv4), remotePort: port(v.remotePort) };
}
function failure(input: unknown): Failure {
  const v = exactSerialRecord(input, ["stage", "category", "atDeviceUs"]);
  return { stage: choice(v.stage, V2_STAGES), category: choice(v.category, V2_FAILURES), atDeviceUs: nullableUInt(v.atDeviceUs) };
}
function event(input: unknown): Event {
  const v = exactSerialRecord(input, ["sequence", "atDeviceUs", "kind", "channelId", "jobId", "submissionSequence", "payloadSha256"]);
  const result = { sequence: uint(v.sequence), ...nullableNumbers(v, ["atDeviceUs", "channelId", "jobId", "submissionSequence"]), kind: choice(v.kind, V2_STAGES), payloadSha256: v.payloadSha256 === null ? null : digest(v.payloadSha256) };
  if (!result.sequence || [result.channelId, result.jobId, result.submissionSequence].some(n => n !== null && n > 0xffffffff) || (["setup", "channel"].includes(result.kind) && result.payloadSha256 !== null)) return fail();
  return result;
}
function timing(input: unknown): Timing {
  const keys = ["maxDurationUs", "totalDurationUs", "firstStartedAtDeviceUs", "lastFinishedAtDeviceUs", "inFlightStartedAtDeviceUs"] as const;
  const v = exactSerialRecord(input, ["operation", "count", "failedCount", ...keys]);
  const result = { operation: choice(v.operation, V2_OPERATIONS), ...numbers(v, ["count", "failedCount"]), ...nullableNumbers(v, keys) };
  if (result.failedCount > result.count || (result.count === 0 && keys.slice(0, 4).some(key => result[key] !== null))) return fail();
  if (result.maxDurationUs !== null && result.totalDurationUs !== null && result.maxDurationUs > result.totalDurationUs) return fail();
  if (result.firstStartedAtDeviceUs !== null && result.lastFinishedAtDeviceUs !== null && result.firstStartedAtDeviceUs > result.lastFinishedAtDeviceUs) return fail();
  return result;
}
function shareFact(input: unknown): ShareFact {
  const required = ["dispatchSequence", "asicJobId", "dispatchedAtDeviceUs", "nonceAtDeviceUs", "nonce", "versionBits", "asicIndex", "coreId", "smallCoreId", "channelId", "jobId", "submissionSequence", "ntime", "version"] as const;
  const nullable = ["writeStartedAtDeviceUs", "writeCompletedAtDeviceUs", "ackAtDeviceUs", "ackLastSequence", "ackAcceptedCount", "ackSharesSum", "matchedSubmitCount"] as const;
  const v = exactSerialRecord(input, [...required, ...nullable, "workFieldsSha256"]);
  const result = { ...numbers(v, required), ...nullableNumbers(v, nullable), workFieldsSha256: digest(v.workFieldsSha256) };
  if (required.filter(key => !key.endsWith("DeviceUs") && key !== "dispatchSequence").some(key => result[key] > 0xffffffff)) return fail();
  if (!result.dispatchSequence || result.asicJobId > 120 || result.asicJobId % 8 !== 0 || result.asicIndex !== 0 || result.coreId > 111 || result.smallCoreId > 7) return fail();
  if (result.nonceAtDeviceUs < result.dispatchedAtDeviceUs || (result.writeStartedAtDeviceUs !== null && result.writeStartedAtDeviceUs < result.nonceAtDeviceUs)) return fail();
  if (result.writeCompletedAtDeviceUs !== null && (result.writeStartedAtDeviceUs === null || result.writeCompletedAtDeviceUs < result.writeStartedAtDeviceUs)) return fail();
  for (const n of [result.ackLastSequence, result.ackAcceptedCount, result.matchedSubmitCount]) if (n !== null && n > 0xffffffff) return fail();
  const ack = [result.ackAtDeviceUs, result.ackLastSequence, result.ackAcceptedCount, result.ackSharesSum, result.matchedSubmitCount];
  if (result.ackAtDeviceUs !== null && ack.slice(1).some(n => n === null)) return fail();
  if (ack.slice(1).some(n => n !== null) && ack.slice(1).some(n => n === null)) return fail();
  if (result.ackAtDeviceUs !== null && (result.writeCompletedAtDeviceUs === null || result.ackAtDeviceUs < result.writeCompletedAtDeviceUs)) return fail();
  return result;
}
function resources(input: unknown): Resources {
  const v = exactSerialRecord(input, ["socketClosed", "workerQuiescent", "fenceRetained", "socketClosedAtUs", "workerQuiescentAtUs"]);
  const result = { socketClosed: boolean(v.socketClosed), workerQuiescent: boolean(v.workerQuiescent), fenceRetained: boolean(v.fenceRetained), ...nullableNumbers(v, ["socketClosedAtUs", "workerQuiescentAtUs"]) };
  if ((!result.socketClosed && result.socketClosedAtUs !== null) || (!result.workerQuiescent && result.workerQuiescentAtUs !== null)) return fail();
  if (result.socketClosedAtUs !== null && result.workerQuiescentAtUs !== null && result.workerQuiescentAtUs < result.socketClosedAtUs) return fail();
  return result;
}
/** Closed device-produced projection, never an independent hardware verdict. */
export function parseWorkerV2DeviceRecord(input: unknown): DeviceRecord {
  const required = ["bootOrdinal", "workerGeneration", "serialTransportEpoch", "admittedAtDeviceUs"] as const;
  const nullable = ["authorityDeadlineDeviceUs", "poolSessionGeneration", "poolTransportEpoch", "observedAtUs", "observationDeadlineDeviceUs", "terminalAtDeviceUs"] as const;
  const v = exactSerialRecord(input, ["schema", "scope", "attemptId", ...required, ...nullable, "jobCommitment", "state", "outcome", "events", "timings", "shareFacts", "firstFailure", "secondaryFailures", "resources"]);
  if (v.schema !== "worker-v2-serial-evidence-v1") return fail();
  const result: DeviceRecord = { schema: v.schema, scope: choice(v.scope, ["channel", "share"]), attemptId: nonce(v.attemptId), ...numbers(v, required), ...nullableNumbers(v, nullable), jobCommitment: v.jobCommitment === null ? null : digest(v.jobCommitment), state: choice(v.state, ["admitted", "running", "terminal"]), outcome: v.outcome === null ? null : choice(v.outcome, ["accepted", "rejected", "expired", "cancelled", "incomplete"] as const), events: array(v.events, 64, event), timings: array(v.timings, 13, timing), shareFacts: array(v.shareFacts, 16, shareFact), firstFailure: v.firstFailure === null ? null : failure(v.firstFailure), secondaryFailures: array(v.secondaryFailures, 16, failure), resources: resources(v.resources) };
  requireRecordConsistency(result);
  return result;
}
function requireRecordConsistency(r: DeviceRecord): void {
  const clockFailed = [r.firstFailure, ...r.secondaryFailures].some(f => f?.category === "clock");
  if (r.bootOrdinal === 0) fail();
  if (r.secondaryFailures.length && !r.firstFailure) fail();
  if (r.secondaryFailures.some(f => !["clock", "cleanup"].includes(f.category))) fail();
  if ((r.authorityDeadlineDeviceUs !== null && r.authorityDeadlineDeviceUs < r.admittedAtDeviceUs) || (r.poolSessionGeneration === null) !== (r.poolTransportEpoch === null)) fail();
  if (r.scope === "channel" && (r.authorityDeadlineDeviceUs !== r.admittedAtDeviceUs + 120000000 || r.observationDeadlineDeviceUs !== r.admittedAtDeviceUs + 125000000 || r.shareFacts.length || r.events.some(e => ["asic_dispatch", "nonce", "submission", "accepted"].includes(e.kind)))) fail();
  if (r.scope === "share") requireShareDeadline(r);
  if ((r.state === "terminal") !== (r.outcome !== null) || (r.state !== "terminal" && r.terminalAtDeviceUs !== null)) fail();
  const times = [r.observedAtUs, ...r.events.map(e => e.atDeviceUs), ...[r.firstFailure, ...r.secondaryFailures].filter((f): f is Failure => f !== null).map(f => f.atDeviceUs)];
  if (r.state === "terminal") times.push(r.terminalAtDeviceUs);
  if (r.resources.socketClosed) times.push(r.resources.socketClosedAtUs);
  if (r.resources.workerQuiescent) times.push(r.resources.workerQuiescentAtUs);
  for (const t of r.timings) if (t.count) times.push(t.maxDurationUs, t.totalDurationUs, t.firstStartedAtDeviceUs, t.lastFinishedAtDeviceUs);
  if (!clockFailed && (times.some(t => t === null) || r.shareFacts.some(f => f.ackLastSequence !== null && f.ackAtDeviceUs === null))) fail();
  if (r.events.some((e, i) => i > 0 && (e.sequence <= r.events[i - 1]!.sequence || (e.atDeviceUs !== null && r.events[i - 1]!.atDeviceUs !== null && e.atDeviceUs < r.events[i - 1]!.atDeviceUs!)))) fail();
  if (new Set(r.timings.map(t => t.operation)).size !== r.timings.length || new Set(r.shareFacts.map(f => f.submissionSequence)).size !== r.shareFacts.length) fail();
  const eventTimes = [...r.events.map(e => e.atDeviceUs), r.terminalAtDeviceUs, r.resources.socketClosedAtUs, r.resources.workerQuiescentAtUs];
  if (eventTimes.some(t => t !== null && (t < r.admittedAtDeviceUs || (r.observedAtUs !== null && t > r.observedAtUs)))) fail();
  if (r.outcome === "accepted" && (r.firstFailure || r.secondaryFailures.length || !r.resources.socketClosed || !r.resources.workerQuiescent || r.resources.fenceRetained || !r.jobCommitment)) fail();
  if (r.scope === "channel" && r.outcome === "accepted" && (r.terminalAtDeviceUs === null || r.authorityDeadlineDeviceUs === null || r.terminalAtDeviceUs > r.authorityDeadlineDeviceUs || !r.events.some(e => e.kind === "work_ready"))) fail();
}
/** The normal allowance clock arms at guarded dispatch, not at admission or successful UART completion. */
function requireShareDeadline(r: DeviceRecord): void {
  if (r.observationDeadlineDeviceUs !== null) fail();
  const workEvents = r.events.filter(e => ["asic_dispatch", "nonce", "submission", "accepted"].includes(e.kind));
  if (r.authorityDeadlineDeviceUs === null) {
    if (workEvents.length || r.shareFacts.length || r.outcome === "accepted") fail();
    return;
  }
  const armedAtUs = r.authorityDeadlineDeviceUs - 180000000;
  if (r.authorityDeadlineDeviceUs % 1000 !== 0 || armedAtUs < Math.floor(r.admittedAtDeviceUs / 1000) * 1000) fail();
  if (r.observedAtUs !== null && armedAtUs > r.observedAtUs) fail();
  if (r.shareFacts.some(f => f.dispatchedAtDeviceUs < armedAtUs) || workEvents.some(e => e.atDeviceUs !== null && e.atDeviceUs < armedAtUs)) fail();
}
/** Runtime-only authenticated view. Contains private network tuples; never dump it to a journal. */
export function parseWorkerV2Status(input: unknown): V2Status {
  if (new TextEncoder().encode(JSON.stringify(input)).length > 65536) return fail();
  const v = exactSerialRecord(input, ["schema", "scope", "state", "observation", "connection", "record"]);
  if (v.schema !== "worker-stratum-v2-status-v1") return fail();
  const o = exactSerialRecord(v.observation, ["bootOrdinal", "workerGeneration", "serialTransportEpoch", "observedAtUs", "clockValid", "stationIpv4", "wifiConnected", "socket"]);
  const observation = { ...numbers(o, ["bootOrdinal", "workerGeneration", "serialTransportEpoch"]), observedAtUs: nullableUInt(o.observedAtUs), clockValid: boolean(o.clockValid), stationIpv4: o.stationIpv4 === null ? null : ipv4(o.stationIpv4), wifiConnected: boolean(o.wifiConnected), socket: o.socket === null ? null : socket(o.socket) };
  const maybeConnection = v.connection === null ? null : (() => {
    const c = exactSerialRecord(v.connection, ["observedAtUs", "bootOrdinal", "workerGeneration", "serialTransportEpoch", "poolSessionGeneration", "poolTransportEpoch", "socket"]);
    return { ...numbers(c, ["observedAtUs", "bootOrdinal", "workerGeneration", "serialTransportEpoch", "poolSessionGeneration", "poolTransportEpoch"]), socket: socket(c.socket) };
  })();
  const maybeRecord = v.record === null ? null : parseWorkerV2DeviceRecord(v.record);
  const result: V2Status = { schema: v.schema, scope: choice(v.scope, ["channel", "share"]), state: choice(v.state, ["idle", "admitted", "running", "terminal"]), observation, connection: maybeConnection, record: maybeRecord };
  if (!observation.bootOrdinal || (!observation.wifiConnected && observation.stationIpv4 !== null)) return fail();
  if (observation.clockValid !== (observation.observedAtUs !== null) || (result.state === "idle") !== (maybeRecord === null)) return fail();
  if (!maybeRecord) { if (maybeConnection || !observation.clockValid || observation.socket) return fail(); return result; }
  if (maybeRecord.scope !== result.scope || maybeRecord.state !== result.state || maybeRecord.bootOrdinal !== observation.bootOrdinal) return fail();
  if (maybeRecord.observedAtUs !== null && observation.observedAtUs !== null && maybeRecord.observedAtUs > observation.observedAtUs) return fail();
  if (maybeRecord.events.some(e => e.kind === "connected") && maybeConnection === null) return fail();
  if (maybeConnection && (["bootOrdinal", "workerGeneration", "serialTransportEpoch", "poolSessionGeneration", "poolTransportEpoch"] as const).some(key => maybeConnection[key] !== maybeRecord[key])) return fail();
  if (maybeConnection && (maybeConnection.observedAtUs < maybeRecord.admittedAtDeviceUs || (maybeRecord.observedAtUs !== null && maybeConnection.observedAtUs > maybeRecord.observedAtUs))) return fail();
  if (maybeRecord.resources.socketClosed && observation.socket !== null) return fail();
  return result;
}
export function parseWorkerV2ChannelStart(input: unknown): ChannelStart {
  const v = exactSerialRecord(input, ["schema", "attemptId", "expectedBootOrdinal", "networkObservedAtUs", "stratum"]);
  if (v.schema !== "worker-stratum-v2-channel-start-v1") return fail();
  return { schema: v.schema, attemptId: nonce(v.attemptId), ...numbers(v, ["expectedBootOrdinal", "networkObservedAtUs"]), stratum: parseWorkerV2Stratum(v.stratum) };
}
/** The only persistable device projection; tuples and observations never escape with it. */
export function projectWorkerV2Evidence(input: unknown): DeviceRecord {
  const status = parseWorkerV2Status(input);
  if (!status.record) return fail();
  return structuredClone(status.record);
}

export { V2_STAGES, V2_OPERATIONS, V2_FAILURES } from "./worker-v2-serial.types";
