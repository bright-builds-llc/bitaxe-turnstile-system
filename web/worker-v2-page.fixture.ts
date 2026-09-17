import { createWorkerV2PageOperations } from "./worker-v2-page";
import { WorkerPreservationBaseline } from "./worker-preservation";
import { serialHarness } from "./worker-serial.test-support";
import { createWebSerialWorkerController, workerSerialQualificationHook } from "./webserial-worker-controller";
import { v2Input, v2Idle, v2Admitted, v2Accepted } from "./worker-v2-serial.fixture";

/** Actual page operations + serial parser/credits/Streams/WebCrypto, with a software device. */
export async function runV2PageSerialConformance(): Promise<void> {
  const h = await serialHarness(), preservation = new WorkerPreservationBaseline();
  const hook = { suppressHeartbeats: false, memoryOnlyContinuity: true,
    stratumV2Pair: { firmwareSourceCommit: "a".repeat(40), appElfSha256: "b".repeat(64), scope: "channel" as const },
    observePreservation: (value: Parameters<WorkerPreservationBaseline["observe"]>[0]) => preservation.observe(value) };
  Object.assign(h.input, { [workerSerialQualificationHook]: hook });
  let current = createWebSerialWorkerController(h.input), phase: "before" | "candidate" = "before", started = false;
  const admitted = v2Admitted(), accepted = v2Accepted();
  h.setNoiseHandler(async command => {
    if (command === "stratum_v2_channel_start") { if (started) throw new Error("duplicate_start"); started = true; return admitted; }
    return started ? accepted : v2Idle();
  });
  const page = createWorkerV2PageOperations({ maybeReviewedBinding: () => undefined, serializeRead: run => run(), changed() {}, phase: () => phase, scope: () => "channel", connected: () => true, idle: () => true, controller: () => current, maybePreservation: () => preservation.maybePublicState() });
  try {
    await current.requestPermission(); await current.status();
    const baselineId = preservation.maybePublicState()?.baseline_id;
    if (!baselineId) throw new Error("v2_before_baseline_missing");
    await current.close();
    phase = "candidate"; current = createWebSerialWorkerController(h.input);
    await current.requestPermission();
    for (let cycle = 0; cycle < 4; cycle++) {
      if ((await current.transportProbe()).responsePayloadBytes !== 65536) throw new Error("v2_cycle_probe_missing");
      await current.close(); current = createWebSerialWorkerController(h.input); await current.requestPermission();
    }
    const binding = await page.stratumV2Possession();
    await page.stratumV2Status("channel", null, binding);
    if ((await page.stratumV2ChannelStart(v2Input, binding)).state !== "admitted") throw new Error("v2_admission_missing");
    if ((await page.stratumV2Status("channel", v2Input.attemptId, binding)).record?.outcome !== "accepted") throw new Error("v2_terminal_missing");
    await current.close();
    current = createWebSerialWorkerController(h.input); await current.requestPermission();
    accepted.observation.workerGeneration++; accepted.observation.serialTransportEpoch++;
    const freshBinding = await page.stratumV2Possession();
    if (binding === freshBinding) throw new Error("v2_fresh_session_missing");
    await page.stratumV2Status("channel", v2Input.attemptId, freshBinding);
    const restored = await current.restore("cancelled");
    if (restored.state !== "baseline" || restored.restoration.status !== "confirmed") throw new Error("v2_restoration_missing");
    const maybeComparison = preservation.maybePublicState();
    if (!maybeComparison || maybeComparison.baseline_id !== baselineId || !maybeComparison.settings_match || !maybeComparison.authorization_high_water_match || !maybeComparison.device_identity_match || maybeComparison.mine_on_boot) throw new Error("v2_original_preservation_lost");
    let rejected = false;
    try { await page.stratumV2ChannelStart(v2Input, freshBinding); } catch (error) { if (!(error instanceof Error) || error.message !== "v2_baseline_required") throw error; rejected = true; }
    if (!rejected || h.received.filter(row => row.command === "stratum_v2_channel_start").length !== 1 || h.received.some(row => row.command === "start_lease")) throw new Error("v2_duplicate_or_work_effect");
  } finally { await current.close(); }
  if (h.counts().locked || h.counts().active || h.counts().opened !== h.counts().closed) throw new Error("v2_serial_cleanup_missing");
}
