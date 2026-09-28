import assert from "node:assert/strict";
import { mock } from "bun:test";
import { createWebSerialWorkerController as createController, workerSerialQualificationHook } from "./webserial-worker-controller";
import type { WebSerialWorkerControllerInput, WorkerSerialQualificationHook } from "./worker-serial-controller.types";
import { workerSerialTestRuntime } from "./webserial-worker-port";
import { serialHarness } from "./worker-serial.test-support";
import { parseWorkerDeploymentTrust } from "./worker-deployment-trust";
import trust from "../conformance/bwg-worker-deployment-trust-0.2/trust.json";
import { progressFixture } from "./worker-mining-progress.fixture";
import { miningInterruptionFixture } from "./worker-mining-interruption.fixture";
import { v2Idle, v2Input } from "./worker-v2-serial.fixture";

const h = await serialHarness(), realCreate = createController;
const scenario = process.argv[2] ?? "matched";
const qualification = (generation = 7) => ({ ...miningInterruptionFixture, generation, mining_progress: { ...progressFixture, schema: "worker-mining-progress-v1" as const, generation }, owner_resources: { schema: "worker-owner-resources-v1" as const, generation, phase: "active" as const, observed_at_ms: "1", heap_free_bytes: 20000, heap_largest_bytes: 8000, stack_free_bytes: 8192 } });
const config = { expectedGateCommit: "c".repeat(40), expectedFirmwareSourceCommit: "a".repeat(40), expectedAppElfSha256: "b".repeat(64),
  trust: parseWorkerDeploymentTrust({ ...trust, workLeaseAuthority: h.trust }), stratumV2Qualification: "before" as const, stratumV2Scope: "share" as const,
  stratumV2Identities: { before: { firmwareSourceCommit: "a".repeat(40), appElfSha256: "b".repeat(64) }, candidate: { firmwareSourceCommit: "a".repeat(40), appElfSha256: "b".repeat(64) } } };
mock.module("./webserial-worker-controller", () => ({ workerSerialQualificationHook,
  createWebSerialWorkerController(input: WebSerialWorkerControllerInput & { [workerSerialQualificationHook]: WorkerSerialQualificationHook }) {
    const adapted = { ...input, [workerSerialTestRuntime]: h.input[workerSerialTestRuntime] }; return realCreate(adapted);
  } }));
mock.module("./worker-acceptance-local", () => ({ acceptanceLocalJson: async (path: string) => {
  if (path === "/context") return scenario === "idle_restart" ? { expectedGateCommit: config.expectedGateCommit, expectedFirmwareSourceCommit: config.expectedFirmwareSourceCommit, expectedAppElfSha256: config.expectedAppElfSha256, trust: config.trust, restartQualification: true } : config;
  if (path === "/activate") return h.input.continuityScope;
  throw Error("unexpected local operation");
} }));
const element = () => ({ textContent: "", value: "", addEventListener() {} });
Object.assign(globalThis, { BWG_GATE_SOURCE_COMMIT: config.expectedGateCommit, window: { addEventListener() {} },
  document: { querySelector: () => element(), getElementById: () => null } });
const { workerAcceptance: page } = await import("./worker-serial-acceptance");
await new Promise(resolve => setTimeout(resolve, 0));
try {
  await page.connect(); const original = page.state().preservation;
  assert.ok(original); await page.stop(); assert.equal(page.state().authorizationRecovery, undefined);
  if (scenario !== "idle_restart") {
  await page.close(); page.configure({ ...config, stratumV2Qualification: "candidate" }); await page.connect();
  h.setNoiseHandler(async () => v2Idle("share"));
  h.setQualification(qualification());
  const binding = await page.stratumV2Possession(); await page.stratumV2Status("share", null, binding);
  const grant = await h.grant({ controlSessionBindingSha256: binding }, { stratum: v2Input.stratum,
    qualificationAttempt: { schema: "worker-qualification-attempt-v1", id: v2Input.attemptId, ordinal: 18, purpose: "normal", maximumActiveMilliseconds: 180000 } });
  page.loadWindow({ grant, renewals: [] });
  // The software device's next authenticated Start response contains its advanced private high-water.
  h.alterPreservation("authorization_high_water_sha256");
  if (scenario === "missing_start_preservation") {
    h.omitPreservation(); await assert.rejects(() => page.startWindow(), /authorization_recovery_boundary/);
    assert.equal(page.state().authorizationRecovery, undefined); assert.equal(h.counts().active, false);
  } else {
  await page.startWindow();
  let maybeFaultId: string | undefined;
  if (scenario === "heartbeat_fault") {
    await page.suppressHeartbeats(); maybeFaultId = page.state().authorizationRecovery?.checkpointId; assert.ok(maybeFaultId);
    h.expireWork(); h.setQualification({ ...qualification(), revocation_reason: "heartbeat_timeout", safe_stop_complete: true, safe_stop_stage: "fan_paused" });
    await h.advance(3000); await page.close(); await page.connect();
  }
  if (scenario === "advance_before_stop") h.alterPreservation("authorization_high_water_sha256", "3".repeat(64));
  if (scenario === "rollback_after_mismatch") { h.alterPreservation("authorization_high_water_sha256", "3".repeat(64)); await page.refresh(); h.alterPreservation("authorization_high_water_sha256"); }
  if (scenario === "missing_stop_preservation") h.omitPreservation();
  if (scenario === "wrong_stop_generation") h.setQualification(qualification(8));
  if (["advance_before_stop", "rollback_after_mismatch", "missing_stop_preservation", "wrong_stop_generation"].includes(scenario)) {
    await assert.rejects(() => page.stop(), /authorization_recovery_normal_stop/);
    assert.equal(page.state().authorizationRecovery, undefined);
    assert.equal(h.counts().active, false);
    assert.equal(page.state().running, false); assert.equal(page.state().deviceRestorationConfirmed, true);
  } else {
  await page.stop();
  const checkpoint = page.state().authorizationRecovery;
  assert.ok(checkpoint, "normal Stop must capture the actual post-authorization checkpoint");
  assert.equal(checkpoint.matched, scenario === "heartbeat_fault" ? true : null);
  if (maybeFaultId) assert.equal(checkpoint.checkpointId, maybeFaultId); assert.equal(checkpoint.generation, 7);
  assert.equal(page.state().preservation?.baseline_id, original.baseline_id);
  assert.equal(page.state().preservation?.authorization_high_water_match, false);
  await page.close();
  if (scenario === "advance_after_close") h.alterPreservation("authorization_high_water_sha256", "3".repeat(64));
  if (scenario === "wrong_reconnect_generation") h.setQualification(qualification(8));
  if (scenario === "missing_reconnect_preservation") h.omitPreservation();
  await page.connect();
  assert.equal(page.state().authorizationRecovery?.checkpointId, checkpoint.checkpointId);
  assert.equal(page.state().authorizationRecovery?.matched, ["matched", "heartbeat_fault"].includes(scenario));
  assert.equal(page.state().preservation?.baseline_id, original.baseline_id);
  assert.equal(page.state().preservation?.authorization_high_water_match, false);
  assert.equal(JSON.stringify(page.state().authorizationRecovery).includes("f".repeat(64)), false);
  await page.refresh(); await page.reviewQualificationAttempts();
  if (["matched", "heartbeat_fault"].includes(scenario)) await page.stop();
  else await assert.rejects(() => page.stop(), /authorization_recovery_normal_stop/);
  await page.close();
  assert.equal(page.state().authorizationRecovery?.checkpointId, checkpoint.checkpointId);
  assert.equal(page.state().authorizationRecovery?.matched, ["matched", "heartbeat_fault"].includes(scenario));
  assert.equal(page.state().preservation?.baseline_id, original.baseline_id);
  assert.equal(page.state().deviceRestorationConfirmed, true);
  assert.equal(page.state().serialOwnershipReleased, true);
  if (scenario === "heartbeat_fault") assert.equal(page.state().qualification?.revocation_reason, "heartbeat_timeout");
  }
  }
  }
} finally { await page.close(); }
assert.equal(h.counts().locked, false); assert.equal(h.counts().active, false);

assert.equal(page.state().status, "closed"); assert.equal(page.state().running, false);
await assert.rejects(() => page.startWindow(), /window_missing_or_active/);
