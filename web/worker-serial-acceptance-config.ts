import { parseWorkerDeploymentTrust, type WorkerDeploymentTrust } from "./worker-deployment-trust";
import { serialRecord } from "./worker-serial";

export type WorkerSerialAcceptanceConfiguration = {
  recoveryPhase?: "loss" | "resume"; expectedGateCommit: string; expectedFirmwareSourceCommit: string;
  expectedAppElfSha256: string; trust: WorkerDeploymentTrust;
};

/** Validate configuration completely before mutating an armed recovery phase. */
export function parseWorkerSerialAcceptanceConfiguration(input: unknown, gateCommit: string): WorkerSerialAcceptanceConfiguration {
  const value = serialRecord(input);
  if (typeof value.expectedGateCommit !== "string" || !/^[0-9a-f]{40}$/u.test(value.expectedGateCommit) || value.expectedGateCommit !== gateCommit) throw new Error("gate_source_mismatch");
  const keys = ["expectedGateCommit", "expectedFirmwareSourceCommit", "expectedAppElfSha256", "trust", "recoveryPhase"];
  const phasePresent = Object.hasOwn(value, "recoveryPhase"), maybePhase = value.recoveryPhase;
  if (typeof value.expectedFirmwareSourceCommit !== "string" || !/^[0-9a-f]{40}$/u.test(value.expectedFirmwareSourceCommit) || typeof value.expectedAppElfSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.expectedAppElfSha256) || Object.keys(value).length !== (phasePresent ? 5 : 4) || Object.keys(value).some(key => !keys.includes(key)) || (phasePresent && maybePhase !== "loss" && maybePhase !== "resume")) throw new Error("configuration_invalid");
  return { expectedGateCommit: value.expectedGateCommit, expectedFirmwareSourceCommit: value.expectedFirmwareSourceCommit,
    expectedAppElfSha256: value.expectedAppElfSha256, trust: parseWorkerDeploymentTrust(value.trust),
    ...(maybePhase === "loss" || maybePhase === "resume" ? { recoveryPhase: maybePhase } : {}) };
}
