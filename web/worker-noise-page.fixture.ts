import { createWorkerNoisePageOperations } from "./worker-noise-page";
import { WorkerPreservationBaseline } from "./worker-preservation";
import { serialHarness } from "./worker-serial.test-support";
import { createWebSerialWorkerController, workerSerialQualificationHook } from "./webserial-worker-controller";
import { noiseInputV2, noiseIdleV2, noiseAdmittedV2, noiseAcceptedV2 } from "./worker-noise-diagnostic.fixture";

/** Actual page operations + serial parser/credits/Streams/WebCrypto, with a software device. */
export async function runNoisePageSerialConformance(): Promise<void> {
  const h = await serialHarness(), preservation = new WorkerPreservationBaseline();
  const hook = { suppressHeartbeats: false, memoryOnlyContinuity: true,
    noiseDiagnosticPair: { firmwareSourceCommit: "a".repeat(40), appElfSha256: "b".repeat(64) },
    observePreservation: (value: Parameters<WorkerPreservationBaseline["observe"]>[0]) => preservation.observe(value) };
  Object.assign(h.input, { [workerSerialQualificationHook]: hook });
  let current = createWebSerialWorkerController(h.input), phase: "before" | "candidate" = "before", started = false;
  const admitted = await noiseAdmittedV2(), accepted = noiseAcceptedV2();
  if (!admitted.job) throw new Error("noise_fixture_job_missing");
  accepted.job.inputSha256 = admitted.job.inputSha256;
  h.setNoiseHandler(async command => {
    if (command === "noise_diagnostic_start") { if (started) throw new Error("duplicate_start"); started = true; return admitted; }
    return started ? accepted : noiseIdleV2();
  });
  const page = createWorkerNoisePageOperations({ changed() {}, phase: () => phase, idle: () => true, controller: () => current, maybePreservation: () => preservation.maybePublicState() });
  try {
    await current.requestPermission(); await current.status();
    const baselineId = preservation.maybePublicState()?.baseline_id;
    if (!baselineId) throw new Error("noise_before_baseline_missing");
    await current.close();
    phase = "candidate"; current = createWebSerialWorkerController(h.input);
    await current.requestPermission();
    const binding = await page.noiseDiagnosticPossession();
    await page.noiseDiagnosticStatus(null, binding);
    if ((await page.noiseDiagnosticStart(noiseInputV2, binding)).state !== "admitted") throw new Error("noise_admission_missing");
    if ((await page.noiseDiagnosticStatus(noiseInputV2.attemptId, binding)).job?.terminal?.outcome !== "accepted") throw new Error("noise_terminal_missing");
    await current.close();
    current = createWebSerialWorkerController(h.input); await current.requestPermission();
    accepted.observation.workerGeneration++; accepted.observation.transportEpoch++;
    const freshBinding = await page.noiseDiagnosticPossession();
    if (binding === freshBinding) throw new Error("noise_fresh_session_missing");
    await page.noiseDiagnosticStatus(noiseInputV2.attemptId, freshBinding);
    const restored = await current.restore("cancelled");
    if (restored.state !== "baseline" || restored.restoration.status !== "confirmed") throw new Error("noise_restoration_missing");
    const maybeComparison = preservation.maybePublicState();
    if (!maybeComparison || maybeComparison.baseline_id !== baselineId || !maybeComparison.settings_match || !maybeComparison.authorization_high_water_match || !maybeComparison.device_identity_match || maybeComparison.mine_on_boot) throw new Error("noise_original_preservation_lost");
    let rejected = false;
    try { await page.noiseDiagnosticStart(noiseInputV2, freshBinding); } catch (error) { if (!(error instanceof Error) || error.message !== "noise_page_start_consumed") throw error; rejected = true; }
    if (!rejected || h.received.filter(row => row.command === "noise_diagnostic_start").length !== 1 || h.received.some(row => row.command === "start_lease")) throw new Error("noise_duplicate_or_work_effect");
  } finally { await current.close(); }
  if (h.counts().locked || h.counts().active || h.counts().opened !== h.counts().closed) throw new Error("noise_serial_cleanup_missing");
}
