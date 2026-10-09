import assert from "node:assert/strict";
import { mock } from "bun:test";
import { createWebSerialWorkerController as createController, workerSerialQualificationHook } from "./webserial-worker-controller";
import type { WebSerialWorkerControllerInput, WorkerSerialQualificationHook } from "./worker-serial-controller.types";
import { workerSerialTestRuntime } from "./webserial-worker-port";
import { serialHarness } from "./worker-serial.test-support";
import { parseWorkerDeploymentTrust } from "./worker-deployment-trust";
import trust from "../conformance/bwg-worker-deployment-trust-0.2/trust.json";
import type { WorkerLeaseGrant, WorkerLeaseRenewal } from "./worker-controller";

// Real page, controller, codec and signature checks; only the browser port and local supervisor are fixtures.
const h = await serialHarness(), realCreate = createController;
const scenario = process.argv[2] ?? "scope_replay";
const config = { expectedGateCommit: "c".repeat(40), expectedFirmwareSourceCommit: "a".repeat(40), expectedAppElfSha256: "b".repeat(64),
  trust: parseWorkerDeploymentTrust({ ...trust, workLeaseAuthority: h.trust }), ...(scenario === "acceptance_config" ? { soakQualification: true } : { restorationQualification: true }) };
const activations: unknown[] = [];
let maybeGrant: WorkerLeaseGrant | undefined, maybeRenewal: WorkerLeaseRenewal | undefined, maybeReplay: unknown;
mock.module("./webserial-worker-controller", () => ({ workerSerialQualificationHook,
  createWebSerialWorkerController(input: WebSerialWorkerControllerInput & { [workerSerialQualificationHook]: WorkerSerialQualificationHook }) {
    assert.equal(input[workerSerialQualificationHook].allowClockDiscontinuityStimulus, true);
    const adapted = { ...input, [workerSerialTestRuntime]: h.input[workerSerialTestRuntime] };
    return realCreate(adapted);
  } }));
mock.module("./worker-acceptance-local", () => ({ acceptanceLocalJson: async (path: string, body?: { controlSessionBindingSha256: string }) => {
  if (path === "/context") return config;
  // The host serves one persistent scenario scope: every connect receives the same challenge.
  if (path === "/activate") { activations.push(structuredClone(h.input.continuityScope)); return structuredClone(h.input.continuityScope); }
  if (path === "/authorization-context" && body) {
    maybeGrant = await h.grant(body); maybeRenewal = await h.renewal(body);
    maybeReplay ??= scenario === "renewal_replay" ? undefined : { operation: "start", grant: maybeGrant };
    return { authorization_context_saved: true };
  }
  if (path === "/scenario-artifacts") return { grant: maybeGrant, renewals: [maybeRenewal] };
  if (path === "/replay-artifact") return maybeReplay ?? { operation: "renew", renewal: maybeRenewal };
  throw Error("unexpected local operation");
} }));
const element = () => ({ textContent: "", value: "", addEventListener() {} });
Object.assign(globalThis, { BWG_GATE_SOURCE_COMMIT: config.expectedGateCommit, window: { addEventListener() {} },
  document: { querySelector: () => element(), getElementById: () => null } });
const { workerRestoration: page } = await import("./worker-restoration-page");
await new Promise(resolve => setTimeout(resolve, 0));
const commands = () => h.received.filter(value => value.kind === "control").map(value => value.command);

if (scenario === "acceptance_config") {
  assert.equal((page.state() as { configurationFailure?: string }).configurationFailure, "configuration_failed");
  await assert.rejects(() => page.connect(), /restoration_mode_required/);
} else if (scenario === "scope_replay") {
  await page.connect(); await page.prepareStart(); await page.loadScenarioLease(); await page.startScenarioLease();
  await page.restoreChallengeSatisfied(); await page.close();
  await page.connect();
  assert.deepEqual(activations[0], activations[1]);
  const before = commands().length;
  const outcome = await page.replayArtifact();
  // The old Start reached the device under the persistent scope; the device, not the Gate, refused it.
  assert.deepEqual(commands().slice(before), ["start_lease"]);
  assert.deepEqual(outcome, { operation: "start", outcome: "rejected", category: "authentication_failed" });
  assert.equal(page.state().connected, false);
  assert.equal(h.counts().locked, false);
} else if (scenario === "expiry_close") {
  await page.connect(); await page.prepareStart(); await page.loadScenarioLease(); await page.startScenarioLease();
  h.expireWork("lease_expired");
  assert.deepEqual(await page.statusReview(), { state: "baseline", restoration: "confirmed", reason: "lease_expired" });
  const before = commands().length;
  await page.close();
  assert.equal(commands().slice(before).includes("restore"), false);
  assert.ok(page.state().journal.entries.some(entry => entry.event === "device_baseline_observed" && entry.category === "lease_expired"));
} else if (scenario === "renewal_replay") {
  let renewals = 0;
  h.setCommandHandler(async request => request.command === "renew_lease" && ++renewals === 2
    ? { ok: false, error: { code: "command_rejected", message: "authentication_failed" } } : undefined);
  await page.connect(); await page.prepareStart(); await page.loadScenarioLease(); await page.startScenarioLease(); await page.renewOnce();
  const outcome = await page.replayArtifact();
  assert.deepEqual(outcome, { operation: "renew", outcome: "rejected", category: "authentication_failed" });
  assert.equal(renewals, 2);
} else if (scenario === "admission_diagnostic") {
  // The real runtime routes device diagnostic frames through the restoration hook into page state.
  await page.connect();
  const line = (stage: string, failure: string) => `worker_admission schema=v1 stage=${stage} first_failure=${failure} readiness=12 budget_reserved_ms=30000 budget_complete=false redacted=true`;
  for (const [stage, failure] of [["preparation", "none"], ["preparation", "none"], ["cleanup", "preparation"]]) await h.sendDiagnostic(line(stage!, failure!));
  await h.advance(100);
  assert.deepEqual(await page.admissionDiagnostic(), { admission: { stage: "cleanup", firstFailure: "preparation", readiness: 12 } });
  assert.deepEqual(page.state().admission, { stage: "cleanup", firstFailure: "preparation", readiness: 12 });
  assert.deepEqual(page.state().journal.entries.filter(entry => entry.event === "admission_observed").map(entry => entry.category), ["none", "preparation"]);
  assert.equal(page.state().connected, true);
  await page.close();
} else throw new Error("unknown scenario");
const published = JSON.stringify(page.state());
for (const value of [maybeGrant?.authorization, maybeGrant?.leaseId, h.input.continuityScope.challengeId, "fixture-session-user", "fixture-session-password"])
  if (value) assert.equal(published.includes(value), false);
