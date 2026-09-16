import { expect, test } from "bun:test";
import { parseNoiseStartInput, parseNoiseStartInputV2, parseNoiseStatus, parseNoiseStatusV2 } from "./worker-noise-diagnostic";
import { noiseInput, noiseInputV2, noiseAccepted, noiseAcceptedV2 } from "./worker-noise-diagnostic.fixture";

test("v1 and v2 readers reject mixed version payloads", () => {
  expect(parseNoiseStartInputV2(noiseInputV2)).toEqual(noiseInputV2);
  expect(() => parseNoiseStartInput(noiseInputV2)).toThrow();
  expect(() => parseNoiseStartInputV2(noiseInput)).toThrow();
  expect(() => parseNoiseStatus(noiseAcceptedV2())).toThrow();
  expect(() => parseNoiseStatusV2(noiseAccepted())).toThrow();
  expect(parseNoiseStatus(noiseAccepted())).toEqual(noiseAccepted());
});
test("v2 records cleanup longer than five seconds inside unchanged authority envelope", () => {
  const status = noiseAcceptedV2();
  status.job.stages[6] = { stage: "socket_closed", sequence: 7, atUs: 8_000_000, durationUs: 7_993_000, bytes: null };
  status.job.stages[7] = { stage: "worker_quiescent", sequence: 8, atUs: 9_000_000, durationUs: 8_993_000, bytes: null };
  status.job.resources.releasedAtUs = 9_000_000;
  status.job.terminal = { outcome: "accepted", decidedAtUs: 9_000_001 };
  status.observation.observedAtUs = 9_000_002;
  expect(parseNoiseStatusV2(status).job?.resources.deadlineMet).toBeTrue();
  expect(() => parseNoiseStatus({ ...status, schema: "worker-noise-diagnostic-status-v1" })).toThrow();
});
test.each([5_007_000, 125_001_001, 125_000_999])("v2 rejects moving or cancellation-relative cleanup horizon %s", deadlineAtUs => {
  const status = noiseAcceptedV2(); status.job.resources.deadlineAtUs = deadlineAtUs;
  expect(() => parseNoiseStatusV2(status)).toThrow("noise_cleanup_deadline");
});
test("v2 actual release by observation horizon cannot authorize late acceptance", () => {
  const status = noiseAcceptedV2();
  status.job.stages[7] = { stage: "worker_quiescent", sequence: 8, atUs: 120_002_000, durationUs: 119_995_000, bytes: null };
  status.job.resources.releasedAtUs = 120_002_000;
  status.job.terminal = { outcome: "accepted", decidedAtUs: 120_002_001 };
  status.observation.observedAtUs = 120_002_002;
  expect(() => parseNoiseStatusV2(status)).toThrow("noise_accepted_proof");
});
test("v2 horizon arithmetic rejects safe-integer overflow", () => {
  const status = noiseAcceptedV2(); status.job.authorityDeadlineUs = Number.MAX_SAFE_INTEGER - 1;
  expect(() => parseNoiseStatusV2(status)).toThrow("noise_integer");
});

test("v2 resource fence persists through incomplete terminal until actual late release", async () => {
  const { WorkerNoiseDiagnosticControl } = await import("./worker-noise-diagnostic-control");
  const status = noiseAcceptedV2();
  status.observation.observedAtUs = 125_001_001;
  status.job.stages = status.job.stages.slice(0, 6);
  status.job.firstFailure = { stage: "proof_written", category: "write", detail: "io", atUs: 7000 };
  status.job.terminal = { outcome: "incomplete", decidedAtUs: 125_001_000 };
  status.job.resources = { socketState: "open", workerState: "running", volatileInputsDisposed: false, startedAtUs: 7000, deadlineAtUs: 125_001_000, releasedAtUs: null, deadlineMet: false, failure: { stage: "cleanup", category: "cleanup", detail: "resource_unreleased", atUs: 125_001_000 } };
  const client = new WorkerNoiseDiagnosticControl({ requireIdle() {}, maybeBinding: () => "binding", possessionFresh: () => true, async request() { return status; } }, "v2");
  await client.status(status.job.attemptId, "binding");
  expect(client.fenced).toBeTrue();
  status.observation.observedAtUs = 126_001_001;
  status.job.resources.socketState = "closed"; status.job.resources.workerState = "quiescent"; status.job.resources.volatileInputsDisposed = true;
  status.job.resources.releasedAtUs = 126_001_000;
  status.job.stages.push({ stage: "socket_closed", sequence: 7, atUs: 126_000_000, durationUs: 125_993_000, bytes: null }, { stage: "worker_quiescent", sequence: 8, atUs: 126_001_000, durationUs: 125_994_000, bytes: null });
  const late = await client.status(status.job.attemptId, "binding");
  expect(client.fenced).toBeFalse();
  expect(late.job?.terminal?.outcome).toBe("incomplete");
  expect(late.job?.resources.deadlineMet).toBeFalse();
});
test("v2 command adapter rejects a v1 response instead of relabeling evidence", async () => {
  const { WorkerNoiseDiagnosticControl } = await import("./worker-noise-diagnostic-control");
  const client = new WorkerNoiseDiagnosticControl({ requireIdle() {}, maybeBinding: () => "binding", possessionFresh: () => true, async request() { return noiseAccepted(); } }, "v2");
  await expect(client.status(noiseInput.attemptId, "binding")).rejects.toThrow("noise_schema");
});
