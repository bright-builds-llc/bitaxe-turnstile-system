import { expect, test } from "bun:test";
import trust from "../conformance/bwg-worker-deployment-trust-0.2/trust.json";
import { requireWorkerAcceptanceModeTransition, parseWorkerSerialAcceptanceConfiguration } from "./worker-serial-acceptance-config";

const base = { expectedGateCommit: "a".repeat(40), expectedFirmwareSourceCommit: "b".repeat(40), expectedAppElfSha256: "c".repeat(64), trust };
test("legacy and explicit recovery configurations retain their closed shape", () => {
  expect(parseWorkerSerialAcceptanceConfiguration(base, base.expectedGateCommit).recoveryPhase).toBeUndefined();
  for (const recoveryPhase of ["loss", "resume"] as const) expect(parseWorkerSerialAcceptanceConfiguration({ ...base, recoveryPhase }, base.expectedGateCommit).recoveryPhase).toBe(recoveryPhase);
});
test.each([{ recoveryPhase: "arbitrary" }, { recoveryPhase: undefined }, { raw: "private" }, { expectedFirmwareSourceCommit: "wrong" }, { trust: {} }])("configuration rejects malformed input before any recovery state mutation", change => {
  expect(() => parseWorkerSerialAcceptanceConfiguration({ ...base, ...change }, base.expectedGateCommit)).toThrow();
});

test("cadence mode is explicit and mutually exclusive with recovery", () => {
  expect(parseWorkerSerialAcceptanceConfiguration({ ...base, cadenceQualification: true }, base.expectedGateCommit).cadenceQualification).toBeTrue();
  for (const value of [{ cadenceQualification: false }, { cadenceQualification: undefined }, { cadenceQualification: true, recoveryPhase: "loss" }]) expect(() => parseWorkerSerialAcceptanceConfiguration({ ...base, ...value }, base.expectedGateCommit)).toThrow();
});

test("sticky mode transitions are rejected before either owner mutates", () => {
  const previous = parseWorkerSerialAcceptanceConfiguration({ ...base, recoveryPhase: "loss" }, base.expectedGateCommit);
  const cadence = parseWorkerSerialAcceptanceConfiguration({ ...base, cadenceQualification: true }, base.expectedGateCommit);
  expect(() => requireWorkerAcceptanceModeTransition(previous, cadence)).toThrow("recovery_phase_downgrade");
  expect(() => requireWorkerAcceptanceModeTransition(cadence, previous)).toThrow("cadence_mode_downgrade");
});

test("restart qualification is explicit, exclusive and sticky", () => {
  const config = parseWorkerSerialAcceptanceConfiguration({ ...base, restartQualification: true }, base.expectedGateCommit);
  expect(config.restartQualification).toBeTrue();
  for (const change of [{ restartQualification: false }, { restartQualification: true, cadenceQualification: true }, { restartQualification: true, recoveryPhase: "loss" }]) expect(() => parseWorkerSerialAcceptanceConfiguration({ ...base, ...change }, base.expectedGateCommit)).toThrow();
  expect(() => requireWorkerAcceptanceModeTransition(config, parseWorkerSerialAcceptanceConfiguration(base, base.expectedGateCommit))).toThrow("restart_mode_downgrade");
});
