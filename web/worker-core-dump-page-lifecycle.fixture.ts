import assert from "node:assert/strict";
import { mock } from "bun:test";
import { parseWorkerDeploymentTrust } from "./worker-deployment-trust";
import { v2Idle } from "./worker-v2-serial.fixture";
import trust from "../conformance/bwg-worker-deployment-trust-0.2/trust.json";
import { workerSerialQualificationHook, type WorkerSerialQualificationHook } from "./worker-serial-controller.types";

let selfTests = 0;
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
      coreDumpSelfTest: async () => { assert.equal(hook.allowCoreDumpSelfTest, true); selfTests++; return {}; },
      prepareWorkerLeaseAuthorizationContext: async () => { assert.equal(hook.stratumV2Pair?.maybeReadOnly, selfTests === 0 && sources.length === 1 ? true : undefined); return { controlSessionBindingSha256: "fresh" }; },
      stratumV2Status: async () => v2Idle("share"),
      qualificationRestartSummary: () => undefined, qualificationRestartEvidence: () => undefined };
  },
}));
const element = () => ({ textContent: "", value: "", addEventListener() {} });
Object.assign(globalThis, { BWG_GATE_SOURCE_COMMIT: "a".repeat(40), window: { addEventListener() {} },
  document: { querySelector: () => element(), getElementById: () => null } });
const { workerAcceptance } = await import("./worker-serial-acceptance");
const identities = { before: { firmwareSourceCommit: "b".repeat(40), appElfSha256: "c".repeat(64) }, candidate: { firmwareSourceCommit: "d".repeat(40), appElfSha256: "e".repeat(64) } };
const configure = (phase: "before" | "candidate") => workerAcceptance.configure({ expectedGateCommit: "a".repeat(40), expectedFirmwareSourceCommit: identities[phase].firmwareSourceCommit, expectedAppElfSha256: identities[phase].appElfSha256, trust: parseWorkerDeploymentTrust(trust), coreDumpSelfTestQualification: true, stratumV2Qualification: phase, stratumV2Scope: "share", stratumV2Identities: identities });
const request = { requestNonce: "A".repeat(22), expectedBootOrdinal: 1 };
configure("before"); await workerAcceptance.connect(); const original = workerAcceptance.state().preservation;
assert.ok(original); const binding = await workerAcceptance.stratumV2Possession(); assert.equal((await workerAcceptance.stratumV2Status("share", null, binding)).state, "idle"); await assert.rejects(() => workerAcceptance.coreDumpSelfTest(request)); assert.equal(selfTests, 0); await workerAcceptance.close();
configure("candidate"); await workerAcceptance.connect(); assert.deepEqual(workerAcceptance.state().preservation, original);
await workerAcceptance.coreDumpSelfTest(request); assert.equal(selfTests, 1); assert.equal(workerAcceptance.state().status, "ready"); await workerAcceptance.close();
configure("candidate"); await workerAcceptance.connect(); await assert.rejects(() => workerAcceptance.coreDumpSelfTest(request)); assert.equal(selfTests, 1); await workerAcceptance.close();
