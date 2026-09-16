import { exactSerialRecord } from "./worker-serial";
import { canonicalJson } from "./headless-values";

export type NoiseIdentity = { firmwareSourceCommit: string; appElfSha256: string };
export type NoiseIdentities = { before: NoiseIdentity; candidate: NoiseIdentity };
export type NoiseConfiguration = { noiseQualification: "before" | "candidate"; noiseIdentities: NoiseIdentities };
function identity(input: unknown): NoiseIdentity {
  const value = exactSerialRecord(input, ["firmwareSourceCommit", "appElfSha256"]);
  if (typeof value.firmwareSourceCommit !== "string" || !/^[0-9a-f]{40}$/u.test(value.firmwareSourceCommit) || typeof value.appElfSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.appElfSha256)) throw new Error("noise_identity_invalid");
  return { firmwareSourceCommit: value.firmwareSourceCommit, appElfSha256: value.appElfSha256 };
}
/** Both exact pairs are frozen before the first preservation observation. */
export function parseNoiseConfiguration(phase: unknown, input: unknown, selected: NoiseIdentity): NoiseConfiguration {
  if (phase !== "before" && phase !== "candidate") throw new Error("noise_phase_invalid");
  const value = exactSerialRecord(input, ["before", "candidate"]);
  const noiseIdentities = { before: identity(value.before), candidate: identity(value.candidate) };
  if (canonicalJson(noiseIdentities[phase]) !== canonicalJson(selected)) throw new Error("noise_pair_mismatch");
  return { noiseQualification: phase, noiseIdentities };
}
/** No phase downgrade, substituted pair or imported candidate-page baseline. */
export function requireNoiseConfigurationTransition(maybePrevious: Partial<NoiseConfiguration> | undefined, next: Partial<NoiseConfiguration>): void {
  if (!maybePrevious?.noiseQualification) {
    if (next.noiseQualification && (maybePrevious || next.noiseQualification !== "before")) throw new Error("noise_before_configuration_required");
    return;
  }
  if (!next.noiseQualification || canonicalJson(maybePrevious.noiseIdentities) !== canonicalJson(next.noiseIdentities)) throw new Error("noise_configuration_changed");
  if (maybePrevious.noiseQualification === "candidate" && next.noiseQualification !== "candidate") throw new Error("noise_phase_downgrade");
}
