import { expect, test } from "bun:test";
import trust from "../conformance/bwg-worker-deployment-trust-0.2/trust.json";
import { parseWorkerSerialAcceptanceConfiguration, requireWorkerAcceptanceModeTransition } from "./worker-serial-acceptance-config";
import { createWorkerNoisePageOperations } from "./worker-noise-page";
import { WorkerPreservationBaseline } from "./worker-preservation";
import { noiseInputV2, noiseIdleV2, noiseAdmittedV2 } from "./worker-noise-diagnostic.fixture";

const identities = { before: { firmwareSourceCommit: "b".repeat(40), appElfSha256: "c".repeat(64) }, candidate: { firmwareSourceCommit: "d".repeat(40), appElfSha256: "e".repeat(64) } };
function configuration(phase: "before" | "candidate") {
  const selected = identities[phase];
  return { expectedGateCommit: "a".repeat(40), expectedFirmwareSourceCommit: selected.firmwareSourceCommit, expectedAppElfSha256: selected.appElfSha256, trust, noiseQualification: phase, noiseIdentities: identities };
}
test("Noise configuration freezes exact pairs and admits only forward same-page transition", () => {
  const before = parseWorkerSerialAcceptanceConfiguration(configuration("before"), "a".repeat(40));
  const candidate = parseWorkerSerialAcceptanceConfiguration(configuration("candidate"), "a".repeat(40));
  requireWorkerAcceptanceModeTransition(undefined, before);
  requireWorkerAcceptanceModeTransition(before, candidate);
  requireWorkerAcceptanceModeTransition(candidate, candidate);
  expect(() => requireWorkerAcceptanceModeTransition(undefined, candidate)).toThrow("noise_before_configuration_required");
  expect(() => requireWorkerAcceptanceModeTransition(candidate, before)).toThrow("noise_phase_downgrade");
  expect(() => requireWorkerAcceptanceModeTransition(candidate, { ...candidate, noiseIdentities: { ...identities, before: identities.candidate } })).toThrow("noise_configuration_changed");
});
test.each([{ noiseQualification: "recovery" }, { noiseIdentities: undefined }, { noiseQualification: undefined }, { cadenceQualification: true }, { restartQualification: true }, { recoveryPhase: "resume" }, { expectedAppElfSha256: "f".repeat(64) }])("Noise config rejects incompatible mode or identity", change => {
  expect(() => parseWorkerSerialAcceptanceConfiguration({ ...configuration("before"), ...change }, "a".repeat(40))).toThrow();
});
test("same-page baseline survives controller replacement and Start is never resent", async () => {
  // Arrange
  const baseline = new WorkerPreservationBaseline();
  const sample = { schema: "worker-preservation-v1" as const, settings_sha256: "1".repeat(64), authorization_high_water_sha256: "2".repeat(64), device_identity_sha256: "3".repeat(64), mine_on_boot: false };
  baseline.observe(sample); const baselineId = baseline.maybePublicState()?.baseline_id;
  let phase: "before" | "candidate" = "before", starts = 0, binding = "first";
  const page = createWorkerNoisePageOperations({ changed() {}, phase: () => phase, idle: () => true, maybePreservation: () => baseline.maybePublicState(), controller: () => ({
    async prepareWorkerLeaseAuthorizationContext() { return { controlSessionBindingSha256: binding }; },
    async noiseDiagnosticStart() { starts++; return noiseAdmittedV2(); },
    async noiseDiagnosticStatus() { return noiseIdleV2(); }, async noiseDiagnosticCancel() { return noiseIdleV2(); },
  }) });
  await expect(page.noiseDiagnosticPossession()).rejects.toThrow("noise_page_admission");
  // Act
  phase = "candidate"; baseline.observe(sample);
  await page.noiseDiagnosticStart(noiseInputV2, await page.noiseDiagnosticPossession());
  binding = "fresh_after_reconnect"; baseline.observe(sample);
  // Assert
  expect(await page.noiseDiagnosticPossession()).toBe(binding);
  expect(baseline.maybePublicState()?.baseline_id).toBe(baselineId);
  await expect(page.noiseDiagnosticStart(noiseInputV2, binding)).rejects.toThrow("noise_page_start_consumed");
  expect(starts).toBe(1);
});
test("missing or changed baseline blocks Start but not cancellation evidence collection", async () => {
  let calls = 0;
  const page = createWorkerNoisePageOperations({ changed() {}, phase: () => "candidate", idle: () => true, maybePreservation: () => undefined, controller: () => ({
    async prepareWorkerLeaseAuthorizationContext() { return { controlSessionBindingSha256: "binding" }; },
    async noiseDiagnosticStart() { calls++; return noiseAdmittedV2(); },
    async noiseDiagnosticStatus() { calls++; return noiseIdleV2(); }, async noiseDiagnosticCancel() { calls++; return noiseIdleV2(); },
  }) });
  await expect(page.noiseDiagnosticStart(noiseInputV2, "binding")).rejects.toThrow("noise_preservation_required");
  await page.noiseDiagnosticCancel(noiseInputV2.attemptId, "binding");
  expect(calls).toBe(1);
});

test("production page and serial controller compose across normal fresh-session restoration", async () => {
  const { runNoisePageSerialConformance } = await import("./worker-noise-page.fixture");
  await runNoisePageSerialConformance();
});
