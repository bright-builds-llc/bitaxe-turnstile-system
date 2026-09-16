import { canonicalJson } from "./headless-values";
import { NOISE_STAGES, type NoiseStatus, type NoiseJob, type NoiseStartInput, type NoiseStartInputAny, type NoiseStartInputV2, type NoiseStatusV2 } from "./worker-noise-diagnostic";

export const noiseInput: NoiseStartInput = { schema: "worker-noise-diagnostic-start-v1", attemptId: "A".repeat(22), expectedBootOrdinal: 1, networkObservedAtUs: 100, fixtureIpv4: "192.168.1.20", fixturePort: 1234, authorityPublicKey: "A".repeat(43) };
export function noiseIdle(): NoiseStatus {
  return { schema: "worker-noise-diagnostic-status-v1", state: "idle", observation: { bootOrdinal: 1, workerGeneration: 7, transportEpoch: 2, observedAtUs: 100, stationIpv4: "192.168.1.10", wifiConnected: true }, job: null };
}
export function noiseJob(): NoiseJob {
  return { attemptId: noiseInput.attemptId, inputSha256: "b".repeat(64), bootOrdinal: 1, workerGeneration: 7, transportEpoch: 2,
    admittedAtUs: 1000, authorityDeadlineUs: 120_001_000, localSocketPort: null, stages: [], firstFailure: null, terminal: null,
    resources: { socketState: "not_created", workerState: "not_started", volatileInputsDisposed: false, startedAtUs: null, deadlineAtUs: null, releasedAtUs: null, deadlineMet: null, failure: null } };
}
export async function noiseAdmitted(input: NoiseStartInputAny = noiseInput): Promise<NoiseStatus> {
  const job = noiseJob();
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(input)));
  job.inputSha256 = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
  return { ...noiseIdle(), observation: { ...noiseIdle().observation, observedAtUs: 1000 }, state: "admitted", job };
}
export function noiseAccepted(): NoiseStatus & { job: NoiseJob } {
  const job = noiseJob();
  job.localSocketPort = 54321;
  job.stages = NOISE_STAGES.map((stage, index) => ({ stage, sequence: index + 1, atUs: 2000 + index * 1000, durationUs: stage === "worker_quiescent" ? 2000 : 500, bytes: stage === "act_one_written" ? 64 : stage === "act_two_received" ? 234 : stage === "proof_written" ? 22 : null }));
  job.terminal = { outcome: "accepted", decidedAtUs: 10000 };
  job.resources = { socketState: "closed", workerState: "quiescent", volatileInputsDisposed: true, startedAtUs: 7000, deadlineAtUs: 5_007_000, releasedAtUs: 9000, deadlineMet: true, failure: null };
  return { ...noiseIdle(), observation: { ...noiseIdle().observation, observedAtUs: 11000 }, state: "terminal", job };
}

export const noiseInputV2: NoiseStartInputV2 = { ...noiseInput, schema: "worker-noise-diagnostic-start-v2" };
export function noiseIdleV2(): NoiseStatusV2 { return { ...noiseIdle(), schema: "worker-noise-diagnostic-status-v2" }; }
export async function noiseAdmittedV2(): Promise<NoiseStatusV2> { return { ...await noiseAdmitted(noiseInputV2), schema: "worker-noise-diagnostic-status-v2" }; }
export function noiseAcceptedV2(): NoiseStatusV2 & { job: NoiseJob } {
  const source = noiseAccepted(); source.job.resources.deadlineAtUs = source.job.authorityDeadlineUs + 5_000_000;
  return { ...source, schema: "worker-noise-diagnostic-status-v2" };
}
