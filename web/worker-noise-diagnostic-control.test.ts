import { expect, test } from "bun:test";
import { WorkerNoiseDiagnosticControl } from "./worker-noise-diagnostic-control";
import { noiseAdmitted, noiseInput, noiseIdle, noiseAccepted, noiseInputV2, noiseIdleV2, noiseAdmittedV2 } from "./worker-noise-diagnostic.fixture";
import { serialHarness } from "./worker-serial.test-support";
import { createWebSerialWorkerController, workerSerialQualificationHook } from "./webserial-worker-controller";

function controlFixture() {
  let binding = "binding", fresh = true;
  const calls: string[] = [];
  let result: unknown = noiseIdle();
  let maybeAfter: (() => void) | undefined;
  const control = new WorkerNoiseDiagnosticControl({ requireIdle() {}, maybeBinding: () => binding, possessionFresh: () => fresh,
    async request(command) { calls.push(command); maybeAfter?.(); return result; } }, "v1");
  return { control, calls, binding: () => binding, expire() { fresh = false; }, replace() { binding = "replacement"; }, result(value: unknown) { result = value; }, after(callback: () => void) { maybeAfter = callback; } };
}
test("running Noise status uses live binding without fresh-admission renewal", async () => {
  // Arrange
  const h = controlFixture(); await h.control.status(null, h.binding());
  h.result(await noiseAdmitted()); await h.control.start(noiseInput, h.binding()); h.expire();
  // Act
  await h.control.status(noiseInput.attemptId, h.binding());
  // Assert
  expect(h.calls).toEqual(["noise_diagnostic_status", "noise_diagnostic_start", "noise_diagnostic_status"]);
  expect(h.control.fenced).toBeTrue();
});
test("expired fresh admission or stale binding never emits a command", async () => {
  const h = controlFixture(); h.expire();
  await expect(h.control.status(null, h.binding())).rejects.toThrow();
  await expect(h.control.cancel(noiseInput.attemptId, "stale")).rejects.toThrow();
  expect(h.calls).toHaveLength(0);
});
test("binding replacement during awaited response fails completion", async () => {
  const h = controlFixture(); h.after(() => h.replace());
  await expect(h.control.status(null, "binding")).rejects.toThrow("noise_possession");
});
test("last delivered idle observation is required and a later query supersedes it", async () => {
  const h = controlFixture(); await h.control.status(null, h.binding());
  h.result({ ...noiseIdle(), observation: { ...noiseIdle().observation, observedAtUs: 101 } });
  await h.control.status(null, h.binding());
  await expect(h.control.start(noiseInput, h.binding())).rejects.toThrow("noise_admission");
  expect(h.calls).toEqual(["noise_diagnostic_status", "noise_diagnostic_status"]);
});
test("ambiguous Start reply consumes the local slot and retains exclusion", async () => {
  const h = controlFixture(); await h.control.status(null, h.binding()); h.result({ private: "invalid" });
  await expect(h.control.start(noiseInput, h.binding())).rejects.toThrow();
  await expect(h.control.start(noiseInput, h.binding())).rejects.toThrow("noise_admission");
  expect(h.calls.filter(command => command === "noise_diagnostic_start")).toHaveLength(1);
  expect(h.control.fenced).toBeTrue();
});
test("Start verifies canonical request digest and original boot generation epoch", async () => {
  for (const change of [{ inputSha256: "f".repeat(64) }, { workerGeneration: 8 }, { transportEpoch: 3 }]) {
    const h = controlFixture(); await h.control.status(null, h.binding()); const admitted = await noiseAdmitted();
    h.result({ ...admitted, observation: { ...admitted.observation, ...change }, job: { ...admitted.job, ...change } });
    await expect(h.control.start(noiseInput, h.binding())).rejects.toThrow();
  }
});
test("terminal review after replacement requires fresh proof and never rearms slot", async () => {
  const h = controlFixture(); await h.control.status(null, h.binding()); h.result(await noiseAdmitted()); await h.control.start(noiseInput, h.binding());
  h.replace(); const accepted = noiseAccepted(); accepted.job.inputSha256 = (await noiseAdmitted()).job!.inputSha256; h.result(accepted);
  await h.control.status(noiseInput.attemptId, h.binding());
  expect(h.control.fenced).toBeFalse();
  await expect(h.control.start(noiseInput, h.binding())).rejects.toThrow("noise_admission");
});
test("cancel cannot claim cancellation for an admitted or unrelated job", async () => {
  const h = controlFixture(); h.result(await noiseAdmitted());
  await expect(h.control.cancel(noiseInput.attemptId, h.binding())).rejects.toThrow("noise_cancel_postcondition");
  h.result(noiseAccepted());
  await expect(h.control.cancel("B".repeat(21) + "A", h.binding())).rejects.toThrow("noise_correlation");
});
test("actual serial controller carries private Noise commands without publishing endpoint or key", async () => {
  // Arrange
  const h = await serialHarness(); const published: unknown[] = [];
  Object.assign(h.input, { [workerSerialQualificationHook]: { suppressHeartbeats: false, allowQualificationRestart: true, noiseDiagnosticPair: { firmwareSourceCommit: "a".repeat(40), appElfSha256: "b".repeat(64) }, observeStatus: (value: unknown) => published.push(value), maybeObserveDiagnostic: (value: unknown) => published.push(value) } });
  h.setNoiseHandler(async command => command === "noise_diagnostic_status" ? noiseIdleV2() : noiseAdmittedV2());
  const controller = createWebSerialWorkerController(h.input); await controller.requestPermission();
  try {
    const context = await controller.prepareWorkerLeaseAuthorizationContext("start");
    // Act
    await controller.noiseDiagnosticStatus(null, context.controlSessionBindingSha256);
    const admitted = await controller.noiseDiagnosticStart(noiseInputV2, context.controlSessionBindingSha256);
    // Assert
    expect(admitted.state).toBe("admitted");
    const serialized = JSON.stringify({ published, trace: controller.exportBrowserSerialTrace() });
    expect(serialized).not.toContain(noiseInput.fixtureIpv4);
    expect(serialized).not.toContain(noiseInput.authorityPublicKey);
    expect(serialized).not.toContain(context.controlSessionBindingSha256);
    const grant = await h.grant(context), before = h.received.length;
    await expect(controller.startLease(grant)).rejects.toThrow("lease_state");
    await expect(controller.rejectStartForRecoveryTest(h.trust)).rejects.toThrow();
    await expect(controller.qualificationCooling("prove_fan")).rejects.toThrow();
    await expect(controller.interruptPendingStatusForQualification()).rejects.toThrow();
    await expect(controller.qualificationRestart({ requestNonce: noiseInput.attemptId, expectedBootOrdinal: 1 })).rejects.toThrow();
    await expect(controller.telemetryCadenceArm("idle")).rejects.toThrow();
    await expect(controller.transportProbe()).rejects.toThrow();
    expect(h.received).toHaveLength(before);
    expect(h.counts().active).toBeFalse();
  } finally { await controller.close(); }
});
test("ordinary or mismatched-pair controller rejects Noise before wire effects", async () => {
  for (const maybePair of [undefined, { firmwareSourceCommit: "c".repeat(40), appElfSha256: "b".repeat(64) }]) {
    const h = await serialHarness();
    if (maybePair) Object.assign(h.input, { [workerSerialQualificationHook]: { suppressHeartbeats: false, allowQualificationRestart: true, noiseDiagnosticPair: maybePair } });
    const controller = createWebSerialWorkerController(h.input); await controller.requestPermission();
    try {
      const context = await controller.prepareWorkerLeaseAuthorizationContext("start"), before = h.received.length;
      await expect(controller.noiseDiagnosticStatus(null, context.controlSessionBindingSha256)).rejects.toThrow("noise_pair_admission");
      expect(h.received).toHaveLength(before);
    } finally { await controller.close(); }
  }
});

test("a connected station without an address cannot admit Start", async () => {
  const h = controlFixture(), idle = noiseIdle(); idle.observation.stationIpv4 = null;
  h.result(idle); await h.control.status(null, h.binding());
  await expect(h.control.start(noiseInput, h.binding())).rejects.toThrow("noise_admission");
  expect(h.calls).toEqual(["noise_diagnostic_status"]);
});
test.each(["inputSha256", "admittedAtUs", "stage", "firstFailure", "terminal"])("retained polling rejects changed %s evidence", async field => {
  // Arrange
  const h = controlFixture(), rejected = noiseAccepted();
  rejected.job.firstFailure = { stage: "proof_written", category: "proof", detail: "malformed", atUs: 7000 };
  rejected.job.terminal = { outcome: "rejected", decidedAtUs: 10000 };
  h.result(rejected); await h.control.status(noiseInput.attemptId, h.binding());
  const changed = structuredClone(rejected);
  if (field === "inputSha256") changed.job.inputSha256 = "c".repeat(64);
  if (field === "admittedAtUs") { changed.job.admittedAtUs--; changed.job.authorityDeadlineUs--; }
  if (field === "stage") changed.job.stages[0]!.durationUs = 499;
  if (field === "firstFailure") changed.job.firstFailure!.detail = "extra";
  if (field === "terminal") { changed.job.firstFailure = null; changed.job.terminal = { outcome: "accepted", decidedAtUs: 10000 }; }
  h.result(changed);
  // Act / Assert
  await expect(h.control.status(noiseInput.attemptId, h.binding())).rejects.toThrow("noise_retained");
});
test("late actual cleanup fills evidence without releasing incomplete job fence", async () => {
  // Arrange
  const h = controlFixture(), incomplete = noiseAccepted();
  incomplete.observation.observedAtUs = 5_007_100;
  incomplete.job.stages = incomplete.job.stages.slice(0, 6);
  incomplete.job.firstFailure = { stage: "proof_written", category: "proof", detail: "malformed", atUs: 7000 };
  incomplete.job.terminal = { outcome: "incomplete", decidedAtUs: 5_007_000 };
  incomplete.job.resources = { socketState: "open", workerState: "running", volatileInputsDisposed: false,
    startedAtUs: 7000, deadlineAtUs: 5_007_000, releasedAtUs: null, deadlineMet: false,
    failure: { stage: "cleanup", category: "cleanup", detail: "resource_unreleased", atUs: 5_007_000 } };
  h.result(incomplete); await h.control.status(noiseInput.attemptId, h.binding());
  const late = structuredClone(incomplete);
  late.observation.observedAtUs = 5_009_000;
  late.job.resources.socketState = "closed"; late.job.resources.workerState = "quiescent";
  late.job.resources.volatileInputsDisposed = true; late.job.resources.releasedAtUs = 5_008_000;
  late.job.stages.push({ stage: "socket_closed", sequence: 7, atUs: 5_007_500, durationUs: 500, bytes: null }, { stage: "worker_quiescent", sequence: 8, atUs: 5_008_000, durationUs: 5_001_000, bytes: null });
  h.result(late);
  // Act
  const reviewed = await h.control.status(noiseInput.attemptId, h.binding());
  // Assert
  expect(reviewed.job?.terminal?.outcome).toBe("incomplete");
  expect(reviewed.job?.resources.releasedAtUs).toBe(5_008_000);
  expect(h.control.fenced).toBeTrue();
  late.job.resources.deadlineMet = true; h.result(late);
  await expect(h.control.status(noiseInput.attemptId, h.binding())).rejects.toThrow();
});

test("failed idle query invalidates the previously delivered host observation", async () => {
  const h = controlFixture(); await h.control.status(null, h.binding()); h.result({ schema: "invalid" });
  await expect(h.control.status(null, h.binding())).rejects.toThrow();
  h.result(await noiseAdmitted());
  await expect(h.control.start(noiseInput, h.binding())).rejects.toThrow("noise_admission");
});

test("caller mutation cannot replace retained idle admission evidence", async () => {
  const h = controlFixture(); const idle = await h.control.status(null, h.binding());
  idle.observation.observedAtUs++;
  await expect(h.control.start({ ...noiseInput, networkObservedAtUs: idle.observation.observedAtUs }, h.binding())).rejects.toThrow("noise_admission");
  expect(h.calls).toEqual(["noise_diagnostic_status"]);
});

test("actual controller retains same-session terminal review beyond fresh Start admission age", async () => {
  // Arrange
  const h = await serialHarness();
  Object.assign(h.input, { [workerSerialQualificationHook]: { suppressHeartbeats: false,
    noiseDiagnosticPair: { firmwareSourceCommit: "a".repeat(40), appElfSha256: "b".repeat(64) } } });
  const { noiseAcceptedV2 } = await import("./worker-noise-diagnostic.fixture");
  const admitted = await noiseAdmittedV2(), accepted = noiseAcceptedV2();
  if (!admitted.job) throw new Error("fixture_job_missing");
  accepted.job.inputSha256 = admitted.job.inputSha256;
  let started = false;
  h.setNoiseHandler(async command => {
    if (command === "noise_diagnostic_start") { started = true; return admitted; }
    return started ? accepted : noiseIdleV2();
  });
  const controller = createWebSerialWorkerController(h.input); await controller.requestPermission();
  try {
    const binding = (await controller.prepareWorkerLeaseAuthorizationContext("start")).controlSessionBindingSha256;
    await controller.noiseDiagnosticStatus(null, binding); await controller.noiseDiagnosticStart(noiseInputV2, binding);
    await h.advance(61_000);
    // Act
    await controller.noiseDiagnosticStatus(noiseInputV2.attemptId, binding);
    const retained = await controller.noiseDiagnosticStatus(noiseInputV2.attemptId, binding);
    const cancelled = await controller.noiseDiagnosticCancel(noiseInputV2.attemptId, binding);
    // Assert: retained evidence does not refresh possession or revive the consumed slot.
    expect(retained.job?.terminal?.outcome).toBe("accepted"); expect(cancelled.job?.terminal?.outcome).toBe("accepted");
    expect(h.received.filter(row => row.command === "prove_possession")).toHaveLength(2);
    const before = h.received.length;
    await expect(controller.noiseDiagnosticStart(noiseInputV2, binding)).rejects.toThrow();
    await expect(controller.noiseDiagnosticStatus(noiseInputV2.attemptId, "different-binding")).rejects.toThrow();
    expect(h.received).toHaveLength(before);
  } finally { await controller.close(); }
});
test("new terminal-review session still needs a fresh first admission", async () => {
  const h = controlFixture(); h.result(noiseAccepted()); h.expire();
  await expect(h.control.status(noiseInput.attemptId, h.binding())).rejects.toThrow("noise_possession");
  expect(h.calls).toHaveLength(0);
});

test("fresh-session terminal retrieval does not become original-job admission", async () => {
  const h = controlFixture(); h.result(noiseAccepted());
  await h.control.status(noiseInput.attemptId, h.binding()); h.expire();
  await expect(h.control.status(noiseInput.attemptId, h.binding())).rejects.toThrow("noise_possession");
  expect(h.calls).toEqual(["noise_diagnostic_status"]);
});
