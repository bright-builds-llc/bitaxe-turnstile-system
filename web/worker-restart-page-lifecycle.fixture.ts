import assert from "node:assert/strict";
import { mock } from "bun:test";
import { parseWorkerDeploymentTrust } from "./worker-deployment-trust";
import trust from "../conformance/bwg-worker-deployment-trust-0.2/trust.json";
import { workerSerialQualificationHook, type WorkerSerialQualificationHook } from "./worker-serial-controller.types";

let settings = "1".repeat(64);
const sources: string[] = [];
const baseline = { protocolVersion: "bwg-worker-controller/0.4", state: "baseline", monotonicMilliseconds: 1, restoration: { status: "confirmed", reason: "cancelled" } } as const;
mock.module("./webserial-worker-controller", () => ({ workerSerialQualificationHook,
  createWebSerialWorkerController(input: { [workerSerialQualificationHook]: WorkerSerialQualificationHook; expectedFirmwareSourceCommit: string }) {
    sources.push(input.expectedFirmwareSourceCommit);
    const hook = input[workerSerialQualificationHook];
    const observe = () => {
      hook.observePreservation?.({ schema: "worker-preservation-v1", settings_sha256: settings, authorization_high_water_sha256: "2".repeat(64), device_identity_sha256: "3".repeat(64), mine_on_boot: false });
      hook.observeStatus?.(baseline); return baseline;
    };
    return { subscribeDisconnect: () => () => {}, requestPermission: async () => { hook.maybeObserveSerialOwnership?.(false); observe(); return { status: "ready", recovered: false }; },
      status: async () => observe(), close: async () => { hook.maybeObserveSerialOwnership?.(true); },
      qualificationRestartSummary: () => undefined, qualificationRestartEvidence: () => undefined };
  },
}));
const element = () => ({ textContent: "", value: "", addEventListener() {} });
Object.assign(globalThis, { BWG_GATE_SOURCE_COMMIT: "a".repeat(40), window: { addEventListener() {} },
  document: { querySelector: () => element(), getElementById: () => null } });
const { workerAcceptance } = await import("./worker-serial-acceptance");
const configure = (source: string, elf: string) => workerAcceptance.configure({ expectedGateCommit: "a".repeat(40), expectedFirmwareSourceCommit: source.repeat(40), expectedAppElfSha256: elf.repeat(64), trust: parseWorkerDeploymentTrust(trust), restartQualification: true });
configure("b", "c"); await workerAcceptance.connect(); const original = workerAcceptance.state().preservation;
assert.ok(original); await workerAcceptance.close();
configure("d", "e"); await workerAcceptance.connect(); const updated = workerAcceptance.state().preservation;
assert.deepEqual(updated, original); assert.equal(workerAcceptance.state().expectedFirmwareSourceCommit, "d".repeat(40)); assert.equal(workerAcceptance.state().expectedAppElfSha256, "e".repeat(64)); await workerAcceptance.close();
settings = "9".repeat(64); configure("f", "0"); await workerAcceptance.connect();
assert.equal(workerAcceptance.state().preservation?.baseline_id, original.baseline_id);
assert.equal(workerAcceptance.state().preservation?.settings_match, false);
assert.equal(workerAcceptance.state().preservation?.authorization_high_water_match, true);
assert.equal(workerAcceptance.state().preservation?.device_identity_match, true);
await workerAcceptance.close();

assert.deepEqual(sources, ["b".repeat(40), "d".repeat(40), "f".repeat(40)]);
