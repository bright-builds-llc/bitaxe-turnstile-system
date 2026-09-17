import { expect, test } from "bun:test";
import { parseWorkerV2Status, projectWorkerV2Evidence, V2_OPERATIONS, type DeviceRecord } from "./worker-v2-serial";
import { WorkerV2SerialHistory } from "./worker-v2-serial-history";
import { v2Idle, v2Admitted, v2Accepted, v2ShareFact } from "./worker-v2-serial.fixture";
import { encodeWorkerSerialEnvelope } from "./worker-serial";

test("runtime tuple survives terminal collection but never enters persisted projection", () => {
  const status = v2Accepted(); expect(parseWorkerV2Status(status)).toEqual(status);
  const evidence = JSON.stringify(projectWorkerV2Evidence(status));
  expect(evidence).not.toContain("192.168."); expect(evidence).not.toContain("54321"); expect(evidence).not.toContain("socket\"");
});
test.each(["endpoint", "password", "ssid", "rawLog"])("unknown private field %s is rejected", field => {
  const status = v2Accepted(); Object.assign(status.record, { [field]: "private" });
  expect(() => parseWorkerV2Status(status)).toThrow();
});
test("idle connected station without IPv4 is truthful but has no endpoint", () => {
  const status = v2Idle(); status.observation.stationIpv4 = null;
  expect(parseWorkerV2Status(status).observation.stationIpv4).toBeNull();
});
test.each(["boot", "clock", "overflow", "terminal", "commitment"])("contradictory status %s is rejected", field => {
  const status = v2Admitted();
  if (field === "boot") status.observation.bootOrdinal++;
  if (field === "clock") status.record.observedAtUs = status.observation.observedAtUs = null;
  if (field === "overflow") status.record.shareFacts = Array(17).fill(v2ShareFact());
  if (field === "terminal") status.record.outcome = "accepted";
  if (field === "commitment") Object.assign(status.record, { jobCommitment: "bad" });
  expect(() => parseWorkerV2Status(status)).toThrow();
});
test("a secondary clock failure preserves the original protocol failure", () => {
  const status = v2Admitted(); status.state = status.record.state = "terminal"; status.record.outcome = "incomplete";
  status.record.firstFailure = { stage: "setup", category: "protocol", atDeviceUs: 1000 };
  status.record.secondaryFailures = [{ stage: "worker_quiescent", category: "clock", atDeviceUs: null }];
  status.record.observedAtUs = status.observation.observedAtUs = null; status.observation.clockValid = false;
  status.record.resources.workerQuiescent = true; status.record.resources.fenceRetained = false;
  expect(parseWorkerV2Status(status).record?.firstFailure?.category).toBe("protocol");
});
test("retained history rejects rewritten admission and erased first failure", () => {
  const history = new WorkerV2SerialHistory(), status = v2Admitted(); history.observe(status);
  const changed = structuredClone(status); changed.record.workerGeneration++;
  expect(() => history.observe(changed)).toThrow();
  status.record.firstFailure = { stage: "setup", category: "protocol", atDeviceUs: 1000 }; history.observe(status);
  status.record.firstFailure = null; expect(() => history.observe(status)).toThrow();
});
test("source-produced ACK fields fill once and cannot rewrite the original nonce", () => {
  const status = v2Admitted("share"), history = new WorkerV2SerialHistory();
  status.record.observedAtUs = status.observation.observedAtUs = 10000;
  status.record.authorityDeadlineDeviceUs = 180001000;
  const fact = v2ShareFact(); status.record.shareFacts = [{ ...fact, ackAtDeviceUs: null, ackLastSequence: null, ackAcceptedCount: null, ackSharesSum: null, matchedSubmitCount: null }];
  history.observe(parseWorkerV2Status(status)); status.record.shareFacts = [fact]; history.observe(parseWorkerV2Status(status));
  fact.nonce++; expect(() => history.observe(status)).toThrow();
});
test("maximum bounded native projection fits the real Serial encoder", async () => {
  const status = v2Admitted("share"), record = status.record;
  record.authorityDeadlineDeviceUs = 180001000;
  record.observedAtUs = status.observation.observedAtUs = Number.MAX_SAFE_INTEGER;
  record.events = Array.from({ length: 64 }, (_, i) => ({ sequence: i + 1, atDeviceUs: 1000 + i, kind: "asic_dispatch", channelId: 0xffffffff, jobId: 0xffffffff, submissionSequence: 0xffffffff, payloadSha256: "f".repeat(64) }));
  record.timings = V2_OPERATIONS.map(operation => ({ operation, count: Number.MAX_SAFE_INTEGER, failedCount: Number.MAX_SAFE_INTEGER, maxDurationUs: Number.MAX_SAFE_INTEGER, totalDurationUs: Number.MAX_SAFE_INTEGER, firstStartedAtDeviceUs: 1000, lastFinishedAtDeviceUs: Number.MAX_SAFE_INTEGER, inFlightStartedAtDeviceUs: Number.MAX_SAFE_INTEGER }));
  record.shareFacts = Array.from({ length: 16 }, (_, i) => ({ ...v2ShareFact(), dispatchSequence: i + 1, submissionSequence: i + 1, ackLastSequence: i + 1 }));
  record.firstFailure = { stage: "worker_quiescent", category: "cleanup", atDeviceUs: 1000 };
  record.secondaryFailures = Array(16).fill({ stage: "worker_quiescent", category: "clock", atDeviceUs: Number.MAX_SAFE_INTEGER });
  const response = { protocolVersion: "bwg-worker-controller/0.4", requestId: "x".repeat(128), ok: true, result: parseWorkerV2Status(status) };
  const bytes = await encodeWorkerSerialEnvelope({ profile: "bwg-worker-serial/0.2", kind: "control", sessionId: "A".repeat(22), sequence: 0xffffffff, payload: response });
  expect(bytes.length).toBeLessThan(65536);
});

test("fresh-session observation retains the original pending job and earlier snapshot timestamp", () => {
  const status = v2Admitted(); status.observation.workerGeneration++; status.observation.serialTransportEpoch++; status.observation.observedAtUs = 1100;
  expect(parseWorkerV2Status(status).record?.observedAtUs).toBe(1000);
  expect(parseWorkerV2Status(status).record?.workerGeneration).toBe(7);
});
