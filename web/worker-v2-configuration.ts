import { canonicalJson } from "./headless-values";
import { parseNoiseConfiguration, type NoiseIdentities, type NoiseIdentity } from "./worker-noise-configuration";
import type { V2Scope } from "./worker-v2-serial.types";
export type WorkerV2Configuration = {
  stratumV2Qualification: "before" | "candidate";
  stratumV2Identities: NoiseIdentities; stratumV2Scope: V2Scope;
};
export function parseWorkerV2Configuration(phase: unknown, identities: unknown, scope: unknown, selected: NoiseIdentity): WorkerV2Configuration {
  const parsed = parseNoiseConfiguration(phase, identities, selected);
  if (scope !== "channel" && scope !== "share") throw new Error("v2_scope_invalid");
  return { stratumV2Qualification: parsed.noiseQualification, stratumV2Identities: parsed.noiseIdentities, stratumV2Scope: scope };
}
export function requireWorkerV2ConfigurationTransition(maybePrevious: Partial<WorkerV2Configuration> | undefined, next: Partial<WorkerV2Configuration>) {
  if (!maybePrevious?.stratumV2Qualification) {
    if (next.stratumV2Qualification && (maybePrevious || next.stratumV2Qualification !== "before")) throw new Error("v2_before_configuration_required");
    return;
  }
  if (!next.stratumV2Qualification || maybePrevious.stratumV2Scope !== next.stratumV2Scope || canonicalJson(maybePrevious.stratumV2Identities) !== canonicalJson(next.stratumV2Identities)) throw new Error("v2_configuration_changed");
  if (maybePrevious.stratumV2Qualification === "candidate" && next.stratumV2Qualification !== "candidate") throw new Error("v2_phase_downgrade");
}

/** Before is inspection-only; only the candidate Share scope may enter existing work/cooling routes. */
export function requireWorkerV2ShareMode(maybeConfiguration: Partial<WorkerV2Configuration> | undefined): void {
  if (maybeConfiguration?.stratumV2Qualification && (maybeConfiguration.stratumV2Qualification !== "candidate" || maybeConfiguration.stratumV2Scope !== "share")) throw new Error("v2_forbids_work");
}
