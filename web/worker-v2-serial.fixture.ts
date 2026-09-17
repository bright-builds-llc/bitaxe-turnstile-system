import type { ChannelStart, DeviceRecord, V2Status, V2Scope, ShareFact } from "./worker-v2-serial";
export const v2Stratum = { profile: "bwg-worker-stratum-v2-standard/0.1" as const, endpoint: "stratum+tcp://192.168.1.20:1234/", authorityPublicKey: "A".repeat(43), userIdentity: "synthetic-v2-fixture" };
export const v2Input: ChannelStart = { schema: "worker-stratum-v2-channel-start-v1", attemptId: "A".repeat(22), expectedBootOrdinal: 1, networkObservedAtUs: 100, stratum: v2Stratum };
export function v2Idle(scope: V2Scope = "channel"): V2Status {
  return { schema: "worker-stratum-v2-status-v1", scope, state: "idle", observation: { bootOrdinal: 1, workerGeneration: 7, serialTransportEpoch: 2, observedAtUs: 100, clockValid: true, stationIpv4: "192.168.1.10", wifiConnected: true, socket: null }, connection: null, record: null };
}
export function v2Admitted(scope: V2Scope = "channel"): V2Status & { record: DeviceRecord } {
  return { ...v2Idle(scope), state: "admitted", observation: { ...v2Idle().observation, observedAtUs: 1000 }, record: { schema: "worker-v2-serial-evidence-v1", scope, attemptId: v2Input.attemptId, bootOrdinal: 1, workerGeneration: 7, serialTransportEpoch: 2, poolSessionGeneration: null, poolTransportEpoch: null, jobCommitment: null, admittedAtDeviceUs: 1000, authorityDeadlineDeviceUs: scope === "channel" ? 120001000 : null, observationDeadlineDeviceUs: scope === "channel" ? 125001000 : null, observedAtUs: 1000, state: "admitted", terminalAtDeviceUs: null, outcome: null, events: [], timings: [], shareFacts: [], firstFailure: null, secondaryFailures: [], resources: { socketClosed: false, workerQuiescent: false, fenceRetained: true, socketClosedAtUs: null, workerQuiescentAtUs: null } } };
}
export function v2Accepted(): V2Status & { record: DeviceRecord } {
  const result = v2Admitted();
  result.state = result.record.state = "terminal"; result.record.outcome = "accepted"; result.record.terminalAtDeviceUs = 15000;
  result.record.observedAtUs = result.observation.observedAtUs = 16000;
  result.record.poolSessionGeneration = 3; result.record.poolTransportEpoch = 4; result.record.jobCommitment = "b".repeat(64);
  result.record.events = ["admitted", "preparing", "connected", "authenticated", "setup", "channel", "job", "target", "work_ready", "socket_closed", "worker_quiescent"].map((kind, index) => ({ sequence: index + 1, kind: kind as DeviceRecord["events"][number]["kind"], atDeviceUs: 1000 + 1000 * index, channelId: null, jobId: null, submissionSequence: null, payloadSha256: null }));
  result.record.resources = { socketClosed: true, workerQuiescent: true, fenceRetained: false, socketClosedAtUs: 10000, workerQuiescentAtUs: 11000 };
  result.connection = { observedAtUs: 3000, bootOrdinal: 1, workerGeneration: 7, serialTransportEpoch: 2, poolSessionGeneration: 3, poolTransportEpoch: 4, socket: { localIpv4: "192.168.1.10", localPort: 54321, remoteIpv4: "192.168.1.20", remotePort: 1234 } };
  return result;
}
export function v2ShareFact(): ShareFact {
  return { dispatchSequence: 1, asicJobId: 8, workFieldsSha256: "c".repeat(64), dispatchedAtDeviceUs: 5000, nonceAtDeviceUs: 6000, writeStartedAtDeviceUs: 7000, writeCompletedAtDeviceUs: 8000, nonce: 3, versionBits: 0, asicIndex: 0, coreId: 1, smallCoreId: 2, channelId: 1, jobId: 2, submissionSequence: 1, ntime: 4, version: 0x20000000, ackAtDeviceUs: 9000, ackLastSequence: 1, ackAcceptedCount: 1, ackSharesSum: 1024, matchedSubmitCount: 1 };
}
