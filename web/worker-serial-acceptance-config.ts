import { parseWorkerDeploymentTrust, type WorkerDeploymentTrust } from "./worker-deployment-trust";
import { serialRecord } from "./worker-serial";

export type WorkerSerialAcceptanceConfiguration = {
  restartQualification?: true; cadenceQualification?: true; recoveryPhase?: "loss" | "resume"; expectedGateCommit: string; expectedFirmwareSourceCommit: string;
  expectedAppElfSha256: string; trust: WorkerDeploymentTrust;
};

/** Validate configuration completely before mutating an armed recovery phase. */
export function parseWorkerSerialAcceptanceConfiguration(input: unknown, gateCommit: string): WorkerSerialAcceptanceConfiguration {
  const value = serialRecord(input);
  if (typeof value.expectedGateCommit !== "string" || !/^[0-9a-f]{40}$/u.test(value.expectedGateCommit) || value.expectedGateCommit !== gateCommit) throw new Error("gate_source_mismatch");
  const keys = ["expectedGateCommit", "expectedFirmwareSourceCommit", "expectedAppElfSha256", "trust", "recoveryPhase", "cadenceQualification", "restartQualification"];
  const restartPresent = Object.hasOwn(value, "restartQualification");
  if (restartPresent && (value.restartQualification !== true || Object.hasOwn(value, "cadenceQualification") || Object.hasOwn(value, "recoveryPhase"))) throw new Error("configuration_invalid");
  const cadencePresent = Object.hasOwn(value, "cadenceQualification");
  if (cadencePresent && (value.cadenceQualification !== true || Object.hasOwn(value, "recoveryPhase"))) throw new Error("configuration_invalid");
  const phasePresent = Object.hasOwn(value, "recoveryPhase"), maybePhase = value.recoveryPhase;
  if (typeof value.expectedFirmwareSourceCommit !== "string" || !/^[0-9a-f]{40}$/u.test(value.expectedFirmwareSourceCommit) || typeof value.expectedAppElfSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.expectedAppElfSha256) || Object.keys(value).length !== (phasePresent || cadencePresent || restartPresent ? 5 : 4) || Object.keys(value).some(key => !keys.includes(key)) || (phasePresent && maybePhase !== "loss" && maybePhase !== "resume")) throw new Error("configuration_invalid");
  return { expectedGateCommit: value.expectedGateCommit, expectedFirmwareSourceCommit: value.expectedFirmwareSourceCommit,
    expectedAppElfSha256: value.expectedAppElfSha256, trust: parseWorkerDeploymentTrust(value.trust),
    ...(restartPresent ? { restartQualification: true as const } : {}),
    ...(cadencePresent ? { cadenceQualification: true as const } : {}),
    ...(maybePhase === "loss" || maybePhase === "resume" ? { recoveryPhase: maybePhase } : {}) };
}

/** Reject incompatible sticky modes before either mode owner can mutate. */
export function requireWorkerAcceptanceModeTransition(maybePrevious: WorkerSerialAcceptanceConfiguration | undefined, next: WorkerSerialAcceptanceConfiguration): void {
  if (maybePrevious?.restartQualification && !next.restartQualification) throw new Error("restart_mode_downgrade");
  if ((maybePrevious?.cadenceQualification || maybePrevious?.recoveryPhase) && next.restartQualification) throw new Error("restart_mode_transition");
  if (maybePrevious?.cadenceQualification && !next.cadenceQualification) throw new Error("cadence_mode_downgrade");
  if (maybePrevious?.recoveryPhase && next.cadenceQualification) throw new Error("recovery_phase_downgrade");
}
