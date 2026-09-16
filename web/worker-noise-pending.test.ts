import { expect, test } from "bun:test";
import { serialHarness } from "./worker-serial.test-support";
import { createWebSerialWorkerController, workerSerialQualificationHook } from "./webserial-worker-controller";
import { isWorkerRestorationPending } from "./worker-control-rejection";
import { workerDeviceBaselineConfirmed } from "./worker-device-baseline";
import { noiseAdmittedV2, noiseIdleV2, noiseInputV2 } from "./worker-noise-diagnostic.fixture";
import type { NoiseStatusV2 } from "./worker-noise-diagnostic";

test("pending Restore preserves Noise possession and fence until real cleanup is observed", async () => {
  // Arrange
  const h = await serialHarness(); let baselineConfirmed = false;
  Object.assign(h.input, { [workerSerialQualificationHook]: { suppressHeartbeats: false,
    noiseDiagnosticPair: { firmwareSourceCommit: "a".repeat(40), appElfSha256: "b".repeat(64) },
    observeStatus(value: unknown) { baselineConfirmed = workerDeviceBaselineConfirmed(value); } } });
  const admitted = await noiseAdmittedV2(); const job = admitted.job;
  if (!job) throw new Error("fixture_job_missing");
  let current: NoiseStatusV2 = noiseIdleV2();
  h.setNoiseHandler(async command => { if (command === "noise_diagnostic_start") current = admitted; return current; });
  const controller = createWebSerialWorkerController(h.input); await controller.requestPermission();
  try {
    const context = await controller.prepareWorkerLeaseAuthorizationContext("start"), binding = context.controlSessionBindingSha256;
    await controller.noiseDiagnosticStatus(null, binding);
    await controller.noiseDiagnosticStart(noiseInputV2, binding);
    expect(baselineConfirmed).toBeFalse();
    h.setRestorationPending(true);
    // Act: the existing typed rejection must not close the current serial owner.
    let maybePending: unknown;
    try { await controller.restore("cancelled"); } catch (error) { maybePending = error; }
    expect(isWorkerRestorationPending(maybePending)).toBeTrue();
    expect(h.counts().closed).toBe(0); expect(h.counts().locked).toBeTrue();
    current = { ...admitted, state: "cancelling", observation: { ...admitted.observation, observedAtUs: 1100 }, job: { ...job,
      firstFailure: { stage: "cleanup", category: "authority_lost", detail: "cancel_requested", atUs: 1100 },
      resources: { ...job.resources, workerState: "running", startedAtUs: 1100, deadlineAtUs: job.authorityDeadlineUs + 5_000_000 } } };
    await controller.noiseDiagnosticStatus(noiseInputV2.attemptId, binding);
    await controller.noiseDiagnosticCancel(noiseInputV2.attemptId, binding);
    await expect(controller.status()).rejects.toThrow("command_rejected");
    await expect(controller.transportProbe()).rejects.toThrow("probe_admission");
    expect(baselineConfirmed).toBeFalse(); expect(h.counts().closed).toBe(0);
    if (!current.job) throw new Error("fixture_job_missing");
    current = { ...current, state: "terminal", observation: { ...current.observation, observedAtUs: 1201 }, job: { ...current.job,
      stages: [{ stage: "worker_quiescent", sequence: 1, atUs: 1200, durationUs: 100, bytes: null }],
      terminal: { outcome: "cancelled", decidedAtUs: 1200 },
      resources: { ...current.job.resources, workerState: "quiescent", volatileInputsDisposed: true, releasedAtUs: 1200, deadlineMet: true } } };
    await controller.noiseDiagnosticStatus(noiseInputV2.attemptId, binding); h.setRestorationPending(false);
    const restored = await controller.restore("cancelled");
    // Assert
    expect(restored.restoration.status).toBe("confirmed"); expect(baselineConfirmed).toBeTrue();
    expect(h.received.filter(row => row.command === "prove_possession")).toHaveLength(2);
    expect(h.received.some(row => row.command === "start_lease")).toBeFalse();
  } finally { await controller.close(); }
});
test("ordinary pending rejection still closes the controller instead of weakening default handling", async () => {
  const h = await serialHarness(); await h.controller.requestPermission(); h.setRestorationPending(true);
  await expect(h.controller.restore("cancelled")).rejects.toThrow("command_rejected");
  await h.controller.close();
  expect(h.counts().closed).toBe(1); expect(h.counts().locked).toBeFalse();
});
test("arbitrary error text cannot activate candidate pending handling", () => {
  expect(isWorkerRestorationPending(new Error("restoration_pending"))).toBeFalse();
  expect(isWorkerRestorationPending({ rejection: "restoration_pending" })).toBeFalse();
});
