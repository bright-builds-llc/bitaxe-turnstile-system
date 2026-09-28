import assert from "node:assert/strict";
import { mock } from "bun:test";
import { createWebSerialWorkerController as createController, workerSerialQualificationHook } from "./webserial-worker-controller";
import type { WebSerialWorkerControllerInput, WorkerSerialQualificationHook } from "./worker-serial-controller.types";
import { workerSerialTestRuntime } from "./webserial-worker-port";
import { serialHarness } from "./worker-serial.test-support";
import { parseWorkerDeploymentTrust } from "./worker-deployment-trust";
import trust from "../conformance/bwg-worker-deployment-trust-0.2/trust.json";
import { v2Idle, v2Accepted, v2Input } from "./worker-v2-serial.fixture";
const scenario = process.argv[2] ?? "changed_image";
const h = await serialHarness(), realCreate = createController;
const before = { firmwareSourceCommit: "a".repeat(40), appElfSha256: "b".repeat(64) };
const candidate = scenario === "same_image" ? before : { firmwareSourceCommit: "d".repeat(40), appElfSha256: "e".repeat(64) };
const config = { expectedGateCommit: "c".repeat(40), expectedFirmwareSourceCommit: before.firmwareSourceCommit, expectedAppElfSha256: before.appElfSha256,
  trust: parseWorkerDeploymentTrust({ ...trust, workLeaseAuthority: h.trust }), stratumV2Qualification: "before" as const, stratumV2Scope: "share" as const,
  stratumV2Identities: { before, candidate }, coreDumpSelfTestQualification: true as const };
mock.module("./webserial-worker-controller", () => ({ workerSerialQualificationHook,
  createWebSerialWorkerController(input: WebSerialWorkerControllerInput & { [workerSerialQualificationHook]: WorkerSerialQualificationHook }) { const adapted = { ...input, [workerSerialTestRuntime]: h.input[workerSerialTestRuntime] }; return realCreate(adapted); } }));
mock.module("./worker-acceptance-local", () => ({ acceptanceLocalJson: async (path: string) => { if (path === "/context") return config; if (path === "/activate") return h.input.continuityScope; throw Error("unexpected_local"); } }));
Object.assign(globalThis, { BWG_GATE_SOURCE_COMMIT: config.expectedGateCommit, window: { addEventListener() {} }, document: { querySelector: () => ({ textContent: "" }), getElementById: () => null } });
const { workerAcceptance: page } = await import("./worker-serial-acceptance");
await new Promise(resolve => setTimeout(resolve, 0));
const terminal = v2Accepted(); terminal.scope = terminal.record.scope = "share"; terminal.record.outcome = "cancelled";
terminal.record.authorityDeadlineDeviceUs = terminal.record.observationDeadlineDeviceUs = null;
terminal.observation.bootOrdinal = terminal.record.bootOrdinal = 9; terminal.connection!.bootOrdinal = 9;
if (scenario === "fenced") terminal.record.resources.fenceRetained = true;
if (scenario === "active") { terminal.record.resources.workerQuiescent = false; terminal.record.resources.workerQuiescentAtUs = null; }
const beforeIdle = v2Idle("share"); beforeIdle.observation.bootOrdinal = 9;
h.setNoiseHandler(async () => scenario === "before_idle" ? beforeIdle : terminal);
try {
  await page.connect(); const original = page.state().preservation;
  const binding = await page.stratumV2Possession(); await page.stratumV2Status("share", scenario === "before_idle" ? null : v2Input.attemptId, binding); 
  if (scenario === "old_mutation") {
    terminal.record.jobCommitment = "f".repeat(64);
    await assert.rejects(() => page.stratumV2Status("share", v2Input.attemptId, binding));
    terminal.record.jobCommitment = "b".repeat(64);
  }
  await page.stop(); await page.close();
  if (scenario === "ordinary_reconnect") {
    await page.connect(); const fresh = await page.stratumV2Possession();
    assert.equal((await page.stratumV2Status("share", v2Input.attemptId, fresh)).record?.bootOrdinal, 9);
    const missing = v2Idle("share"); missing.observation.bootOrdinal = 9;
    h.setNoiseHandler(async () => missing);
    await assert.rejects(() => page.stratumV2Status("share", null, fresh));
    await page.close(); h.setNoiseHandler(async () => terminal);
  }
  const next = { ...config, stratumV2Qualification: "candidate" as const, expectedFirmwareSourceCommit: candidate.firmwareSourceCommit, expectedAppElfSha256: candidate.appElfSha256 };
  page.configure(next);
  if (scenario !== "wrong_identity") h.setImageIdentity(candidate.firmwareSourceCommit, candidate.appElfSha256);
  if (scenario === "wrong_identity") { await assert.rejects(() => page.connect()); }
  else {
    if (scenario === "preservation_mismatch") h.alterPreservation("settings_sha256");
    await page.connect(); const fresh = await page.stratumV2Possession();
    const idle = v2Idle("share"); idle.observation.bootOrdinal = scenario === "same_boot" ? 9 : scenario === "rollback_boot" ? 8 : 10;
    h.setNoiseHandler(async () => idle);
    if (["same_boot", "rollback_boot", "same_image", "active", "fenced", "preservation_mismatch"].includes(scenario)) await assert.rejects(() => page.stratumV2Status("share", null, fresh));
    else {
      assert.equal((await page.stratumV2Status("share", null, fresh)).state, "idle");
      assert.equal(page.state().preservation?.baseline_id, original?.baseline_id);
      assert.equal(page.state().preservation?.authorization_high_water_match, true);
      await page.stop(); await page.close();
      assert.throws(() => page.configure(config));
      page.configure(next); await page.connect(); const again = await page.stratumV2Possession();
      assert.equal((await page.stratumV2Status("share", null, again)).state, "idle");
      if (scenario === "self_test_restart") {
        h.setBootOrdinal(10); h.setRestartScenario("same_stream");
        const result = await page.coreDumpSelfTest({ requestNonce: "A".repeat(22), expectedBootOrdinal: 10 });
        assert.equal(result.summary.stage, "complete"); assert.equal(result.summary.panicResetObserved, true);
        idle.observation.bootOrdinal = 11;
        const rebound = await page.stratumV2Possession();
        assert.equal((await page.stratumV2Status("share", null, rebound)).observation.bootOrdinal, 11);
        await page.close(); await page.connect(); const reconnected = await page.stratumV2Possession();
        assert.equal((await page.stratumV2Status("share", null, reconnected)).state, "idle");
        assert.equal(page.state().preservation?.baseline_id, original?.baseline_id);
        await assert.rejects(() => page.coreDumpSelfTest({ requestNonce: "B".repeat(22), expectedBootOrdinal: 11 }));
      }
      if (scenario === "old_replay") { h.setNoiseHandler(async () => terminal); await assert.rejects(() => page.stratumV2Status("share", v2Input.attemptId, again)); }
    }
  }
} finally { await page.close(); }
assert.equal(h.counts().locked, false); assert.equal(h.counts().active, false);
assert.equal(h.received.some(row => (scenario === "self_test_restart" ? ["start_lease", "qualification_restart"] : ["start_lease", "qualification_core_dump_self_test", "qualification_restart"]).includes(String(row.command))), false);
