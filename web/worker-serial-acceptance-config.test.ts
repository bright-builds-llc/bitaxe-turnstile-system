import { expect, test } from "bun:test";
import trust from "../conformance/bwg-worker-deployment-trust-0.2/trust.json";
import { parseWorkerSerialAcceptanceConfiguration } from "./worker-serial-acceptance-config";

const base = { expectedGateCommit: "a".repeat(40), expectedFirmwareSourceCommit: "b".repeat(40), expectedAppElfSha256: "c".repeat(64), trust };
test("legacy and explicit recovery configurations retain their closed shape", () => {
  expect(parseWorkerSerialAcceptanceConfiguration(base, base.expectedGateCommit).recoveryPhase).toBeUndefined();
  for (const recoveryPhase of ["loss", "resume"] as const) expect(parseWorkerSerialAcceptanceConfiguration({ ...base, recoveryPhase }, base.expectedGateCommit).recoveryPhase).toBe(recoveryPhase);
});
test.each([{ recoveryPhase: "arbitrary" }, { recoveryPhase: undefined }, { raw: "private" }, { expectedFirmwareSourceCommit: "wrong" }, { trust: {} }])("configuration rejects malformed input before any recovery state mutation", change => {
  expect(() => parseWorkerSerialAcceptanceConfiguration({ ...base, ...change }, base.expectedGateCommit)).toThrow();
});
