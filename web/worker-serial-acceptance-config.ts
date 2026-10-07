import { canonicalJson } from "./headless-values";
import { parseWorkerV2Configuration, requireWorkerV2ConfigurationTransition, type WorkerV2Configuration } from "./worker-v2-configuration";
import { parseNoiseConfiguration, requireNoiseConfigurationTransition, type NoiseConfiguration } from "./worker-noise-configuration";
import { parseWorkerDeploymentTrust, type WorkerDeploymentTrust } from "./worker-deployment-trust";
import { serialRecord } from "./worker-serial";

export type WorkerSerialAcceptanceConfiguration = Partial<NoiseConfiguration> & Partial<WorkerV2Configuration> & {
  coreDumpSelfTestQualification?: true; restartQualification?: true; cadenceQualification?: true; stationEndpointHandoff?: true; soakQualification?: true; restorationQualification?: true; recoveryPhase?: "loss" | "resume"; expectedGateCommit: string; expectedFirmwareSourceCommit: string;
  expectedAppElfSha256: string; trust: WorkerDeploymentTrust;
};

/** Validate configuration completely before mutating an armed recovery phase. */
export function parseWorkerSerialAcceptanceConfiguration(input: unknown, gateCommit: string): WorkerSerialAcceptanceConfiguration {
  const value = serialRecord(input);
  if (typeof value.expectedGateCommit !== "string" || !/^[0-9a-f]{40}$/u.test(value.expectedGateCommit) || value.expectedGateCommit !== gateCommit) throw new Error("gate_source_mismatch");
  const keys = ["expectedGateCommit", "expectedFirmwareSourceCommit", "expectedAppElfSha256", "trust", "recoveryPhase", "cadenceQualification", "restartQualification", "noiseQualification", "noiseIdentities", "stratumV2Qualification", "stratumV2Identities", "stratumV2Scope", "coreDumpSelfTestQualification", "stationEndpointHandoff", "soakQualification", "restorationQualification"];
  const selfTestPresent = Object.hasOwn(value, "coreDumpSelfTestQualification");
  if (selfTestPresent && (value.coreDumpSelfTestQualification !== true || ["restartQualification", "noiseQualification", "cadenceQualification", "recoveryPhase"].some(key => Object.hasOwn(value, key)))) throw new Error("configuration_invalid");
  const v2Present = Object.hasOwn(value, "stratumV2Qualification");
  if (v2Present && ["noiseQualification", "noiseIdentities", "restartQualification", "cadenceQualification", "recoveryPhase"].some(key => Object.hasOwn(value, key))) throw new Error("configuration_invalid");
  const noisePresent = Object.hasOwn(value, "noiseQualification");
  if (noisePresent && ["restartQualification", "cadenceQualification", "recoveryPhase"].some(key => Object.hasOwn(value, key))) throw new Error("configuration_invalid");
  const restartPresent = Object.hasOwn(value, "restartQualification");
  if (restartPresent && (value.restartQualification !== true || Object.hasOwn(value, "cadenceQualification") || Object.hasOwn(value, "recoveryPhase"))) throw new Error("configuration_invalid");
  const cadencePresent = Object.hasOwn(value, "cadenceQualification");
  if (cadencePresent && (value.cadenceQualification !== true || Object.hasOwn(value, "recoveryPhase"))) throw new Error("configuration_invalid");
  const endpointPresent = Object.hasOwn(value, "stationEndpointHandoff");
  if (endpointPresent && (value.stationEndpointHandoff !== true || ["recoveryPhase", "cadenceQualification", "restartQualification", "noiseQualification", "noiseIdentities", "stratumV2Qualification", "stratumV2Identities", "stratumV2Scope", "coreDumpSelfTestQualification"].some(key => Object.hasOwn(value, key)))) throw new Error("configuration_invalid");
  // A soak runs alone: no recovery phase, cadence, restart, Noise, Stratum V2, self-test or one-use endpoint handoff.
  const soakPresent = Object.hasOwn(value, "soakQualification");
  if (soakPresent && (value.soakQualification !== true || ["recoveryPhase", "cadenceQualification", "restartQualification", "noiseQualification", "noiseIdentities", "stratumV2Qualification", "stratumV2Identities", "stratumV2Scope", "coreDumpSelfTestQualification", "stationEndpointHandoff"].some(key => Object.hasOwn(value, key)))) throw new Error("configuration_invalid");
  // Restoration qualification (BWG-007) runs alone as well; it is the only mode admitting unbudgeted Conservative leases.
  const restorationPresent = Object.hasOwn(value, "restorationQualification");
  if (restorationPresent && (value.restorationQualification !== true || keys.some(key => key !== "restorationQualification" && !["expectedGateCommit", "expectedFirmwareSourceCommit", "expectedAppElfSha256", "trust"].includes(key) && Object.hasOwn(value, key)))) throw new Error("configuration_invalid");
  const phasePresent = Object.hasOwn(value, "recoveryPhase"), maybePhase = value.recoveryPhase;
  if (typeof value.expectedFirmwareSourceCommit !== "string" || !/^[0-9a-f]{40}$/u.test(value.expectedFirmwareSourceCommit) || typeof value.expectedAppElfSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.expectedAppElfSha256) || Object.keys(value).length !== Number(selfTestPresent) + (v2Present ? 7 : noisePresent ? 6 : phasePresent || cadencePresent || restartPresent || endpointPresent || soakPresent || restorationPresent ? 5 : 4) || Object.keys(value).some(key => !keys.includes(key)) || (phasePresent && maybePhase !== "loss" && maybePhase !== "resume")) throw new Error("configuration_invalid");
  const maybeNoise = noisePresent ? parseNoiseConfiguration(value.noiseQualification, value.noiseIdentities, { firmwareSourceCommit: value.expectedFirmwareSourceCommit, appElfSha256: value.expectedAppElfSha256 }) : undefined;
  const maybeV2 = v2Present ? parseWorkerV2Configuration(value.stratumV2Qualification, value.stratumV2Identities, value.stratumV2Scope, { firmwareSourceCommit: value.expectedFirmwareSourceCommit, appElfSha256: value.expectedAppElfSha256 }) : undefined;
  return { ...maybeV2, ...maybeNoise, expectedGateCommit: value.expectedGateCommit, expectedFirmwareSourceCommit: value.expectedFirmwareSourceCommit,
    expectedAppElfSha256: value.expectedAppElfSha256, trust: parseWorkerDeploymentTrust(value.trust),
    ...(selfTestPresent ? { coreDumpSelfTestQualification: true as const } : {}),
    ...(restartPresent ? { restartQualification: true as const } : {}),
    ...(cadencePresent ? { cadenceQualification: true as const } : {}),
    ...(endpointPresent ? { stationEndpointHandoff: true as const } : {}),
    ...(soakPresent ? { soakQualification: true as const } : {}),
    ...(restorationPresent ? { restorationQualification: true as const } : {}),
    ...(maybePhase === "loss" || maybePhase === "resume" ? { recoveryPhase: maybePhase } : {}) };
}

/** Reject incompatible sticky modes before either mode owner can mutate. */
export function requireWorkerAcceptanceModeTransition(maybePrevious: WorkerSerialAcceptanceConfiguration | undefined, next: WorkerSerialAcceptanceConfiguration): void {
  if (maybePrevious && maybePrevious.coreDumpSelfTestQualification !== next.coreDumpSelfTestQualification) throw new Error("core_dump_self_test_mode_changed");
  requireNoiseConfigurationTransition(maybePrevious, next);
  requireWorkerV2ConfigurationTransition(maybePrevious, next);
  if (maybePrevious?.stratumV2Qualification && (maybePrevious.expectedGateCommit !== next.expectedGateCommit || canonicalJson(maybePrevious.trust) !== canonicalJson(next.trust))) throw new Error("v2_gate_or_trust_changed");
  if (maybePrevious?.noiseQualification && maybePrevious.expectedGateCommit !== next.expectedGateCommit) throw new Error("noise_gate_changed");
  if (maybePrevious && maybePrevious.stationEndpointHandoff !== next.stationEndpointHandoff) throw new Error("station_endpoint_mode_changed");
  if (maybePrevious && maybePrevious.soakQualification !== next.soakQualification) throw new Error("soak_mode_changed");
  if (maybePrevious && maybePrevious.restorationQualification !== next.restorationQualification) throw new Error("restoration_mode_changed");
  if (maybePrevious?.restartQualification && !next.restartQualification) throw new Error("restart_mode_downgrade");
  if ((maybePrevious?.cadenceQualification || maybePrevious?.recoveryPhase) && next.restartQualification) throw new Error("restart_mode_transition");
  if (maybePrevious?.cadenceQualification && !next.cadenceQualification) throw new Error("cadence_mode_downgrade");
  if (maybePrevious?.recoveryPhase && next.cadenceQualification) throw new Error("recovery_phase_downgrade");
}
