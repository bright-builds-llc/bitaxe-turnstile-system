import { expect, test } from "bun:test";
import { requireWorkerV2FaultHeadroom, serializeWorkerAcceptanceRead } from "./worker-acceptance-fault";
import { parseWorkerControllerStatus } from "./worker-controller";

test("application read ownership releases after rejection without extending any deadline", async () => {
  let busy = false;
  await expect(serializeWorkerAcceptanceRead({ polling: () => busy, claim: value => { busy = value; }, run: async () => { throw Error("request_failed"); } })).rejects.toThrow("request_failed");
  expect(busy).toBeFalse();
});
test("V2 heartbeat fault refuses absent work headroom and baseline state", () => {
  const baseline = { protocolVersion: "bwg-worker-controller/0.4", state: "baseline", monotonicMilliseconds: 1, restoration: { status: "confirmed", reason: "cancelled" } };
  expect(() => requireWorkerV2FaultHeadroom(parseWorkerControllerStatus(baseline))).toThrow("v2_fault_headroom");
});

test("V2 fault requires five seconds on both distinct device deadlines", async () => {
  const { miningInterruptionFixture } = await import("./worker-mining-interruption.fixture");
  const status = { protocolVersion: "bwg-worker-controller/0.4" as const, state: "mining" as const, monotonicMilliseconds: 1000,
    lease: { leaseId: "lease", challengeId: "challenge", renewAtMonotonicMilliseconds: 2000, expiresAtMonotonicMilliseconds: 6000 },
    restoration: { status: "pending" as const }, qualification: { ...miningInterruptionFixture, work_gate_remaining_ms: 5000 } };
  expect(() => requireWorkerV2FaultHeadroom(status)).not.toThrow();
  expect(() => requireWorkerV2FaultHeadroom({ ...status, lease: { ...status.lease, expiresAtMonotonicMilliseconds: 5999 } })).toThrow();
  expect(() => requireWorkerV2FaultHeadroom({ ...status, qualification: { ...status.qualification, work_gate_remaining_ms: 4999 } })).toThrow();
});

test("suppression returns the fresh guard response rather than cached UI headroom", async () => {
  const { captureWorkerV2HeartbeatFault } = await import("./worker-acceptance-fault");
  const { miningInterruptionFixture } = await import("./worker-mining-interruption.fixture");
  let uiGeneration = 7, suppressed = false, reads = 0;
  const fresh = { protocolVersion: "bwg-worker-controller/0.4" as const, state: "mining" as const, monotonicMilliseconds: 12000,
    lease: { leaseId: "lease", challengeId: "challenge", renewAtMonotonicMilliseconds: 20000, expiresAtMonotonicMilliseconds: 53000 },
    restoration: { status: "pending" as const }, qualification: { ...miningInterruptionFixture, generation: 19, work_gate_remaining_ms: 87000 } };
  const receipt = await captureWorkerV2HeartbeatFault({ status: async () => { reads++; return fresh; },
    observe(status) { uiGeneration = status.qualification!.generation; }, suppress() { suppressed = true; } });
  expect(receipt).toEqual({ schema: "worker-v2-fault-headroom-v1", workerGeneration: 19, headroomObservedAtDeviceUs: 12000000, leaseRemainingMs: 41000, workGateRemainingMs: 87000 });
  expect(reads).toBe(1); expect(suppressed).toBeTrue(); expect(uiGeneration).toBe(19);
});

test("positive remaining time cannot authorize a fault after independent revocation", async () => {
  const { miningInterruptionFixture } = await import("./worker-mining-interruption.fixture");
  const fresh = { protocolVersion: "bwg-worker-controller/0.4" as const, state: "mining" as const, monotonicMilliseconds: 1000,
    lease: { leaseId: "lease", challengeId: "challenge", renewAtMonotonicMilliseconds: 2000, expiresAtMonotonicMilliseconds: 6000 },
    restoration: { status: "pending" as const }, qualification: { ...miningInterruptionFixture, work_gate_remaining_ms: 5000 } };
  expect(() => requireWorkerV2FaultHeadroom({ ...fresh, qualification: { ...fresh.qualification, revocation_reason: "unsafe_observation" } })).toThrow("v2_fault_headroom");
  expect(() => requireWorkerV2FaultHeadroom({ ...fresh, qualification: { ...fresh.qualification, safe_stop_complete: true } })).toThrow("v2_fault_headroom");
});
