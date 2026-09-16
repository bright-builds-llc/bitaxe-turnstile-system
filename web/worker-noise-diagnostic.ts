import { exactSerialRecord, serialFailure } from "./worker-serial";
import { NOISE_STAGES, NOISE_FAILURE_STAGES, NOISE_CATEGORIES, NOISE_DETAILS, NOISE_OUTCOMES, type NoiseDeviceFailure, type NoiseRelease, type NoiseJob, type NoiseStatus, type NoiseStartInput, type NoiseStageObservation, type NoiseStage } from "./worker-noise-diagnostic.types";
import { noiseUInt, maybeNoiseUInt, noisePositive, noisePort, noiseBoolean, noiseEnum, noiseAttemptId, noiseAuthorityKey, noiseDigest, noisePrivateIpv4 } from "./worker-noise-diagnostic-values";
export * from "./worker-noise-diagnostic.types";

// noise_sv2 1.4.2: 64-byte ephemeral + 80-byte encrypted static + 90-byte certificate.
export const NOISE_ACT_TWO_BYTES = 234;
export function parseNoiseStartInput(input: unknown): NoiseStartInput {
  const value = exactSerialRecord(input, ["schema", "attemptId", "expectedBootOrdinal", "networkObservedAtUs", "fixtureIpv4", "fixturePort", "authorityPublicKey"]);
  if (value.schema !== "worker-noise-diagnostic-start-v1") throw serialFailure("noise_schema");
  return { schema: value.schema, attemptId: noiseAttemptId(value.attemptId), expectedBootOrdinal: noisePositive(value.expectedBootOrdinal), networkObservedAtUs: noiseUInt(value.networkObservedAtUs), fixtureIpv4: noisePrivateIpv4(value.fixtureIpv4), fixturePort: noisePort(value.fixturePort), authorityPublicKey: noiseAuthorityKey(value.authorityPublicKey) };
}
function maybeFailure(input: unknown): NoiseDeviceFailure | null {
  if (input === null) return null;
  const value = exactSerialRecord(input, ["stage", "category", "detail", "atUs"]);
  return { stage: noiseEnum(value.stage, NOISE_FAILURE_STAGES), category: noiseEnum(value.category, NOISE_CATEGORIES), detail: noiseEnum(value.detail, NOISE_DETAILS), atUs: maybeNoiseUInt(value.atUs) };
}
function release(input: unknown): NoiseRelease {
  const value = exactSerialRecord(input, ["socketState", "workerState", "volatileInputsDisposed", "startedAtUs", "deadlineAtUs", "releasedAtUs", "deadlineMet", "failure"]);
  const result: NoiseRelease = {
    socketState: noiseEnum(value.socketState, ["not_created", "open", "closed"]), workerState: noiseEnum(value.workerState, ["not_started", "running", "quiescent"]),
    volatileInputsDisposed: noiseBoolean(value.volatileInputsDisposed), startedAtUs: maybeNoiseUInt(value.startedAtUs), deadlineAtUs: maybeNoiseUInt(value.deadlineAtUs),
    releasedAtUs: maybeNoiseUInt(value.releasedAtUs), deadlineMet: value.deadlineMet === null ? null : noiseBoolean(value.deadlineMet), failure: maybeFailure(value.failure),
  };
  if (result.startedAtUs !== null && result.deadlineAtUs !== null && result.deadlineAtUs - result.startedAtUs !== 5_000_000) throw serialFailure("noise_cleanup_deadline");
  if (result.releasedAtUs !== null && result.startedAtUs !== null && result.releasedAtUs < result.startedAtUs) throw serialFailure("noise_cleanup_order");
  if (result.deadlineMet === true && (result.startedAtUs === null || result.deadlineAtUs === null || result.releasedAtUs === null || result.releasedAtUs > result.deadlineAtUs || result.socketState === "open" || result.workerState === "running" || !result.volatileInputsDisposed || result.failure !== null)) throw serialFailure("noise_cleanup_proof");
  return result;
}
function stages(input: unknown): NoiseStageObservation[] {
  if (!Array.isArray(input) || input.length > NOISE_STAGES.length) throw serialFailure("noise_stages");
  let previousIndex = -1, previousTime = 0;
  return input.map((item, index) => {
    const value = exactSerialRecord(item, ["stage", "sequence", "atUs", "durationUs", "bytes"]);
    const stage = noiseEnum(value.stage, NOISE_STAGES), stageIndex = NOISE_STAGES.indexOf(stage);
    const sequence = noisePositive(value.sequence), atUs = maybeNoiseUInt(value.atUs), durationUs = maybeNoiseUInt(value.durationUs), bytes = maybeNoiseUInt(value.bytes);
    if (sequence !== index + 1 || stageIndex <= previousIndex || (atUs !== null && atUs < previousTime) || (atUs !== null && durationUs !== null && durationUs > atUs)) throw serialFailure("noise_stage_order");
    if (!["act_one_written", "act_two_received", "proof_written"].includes(stage) && bytes !== null) throw serialFailure("noise_stage_bytes");
    previousIndex = stageIndex;
    if (atUs !== null) previousTime = atUs;
    return { stage, sequence, atUs, durationUs, bytes };
  });
}
function maybeTerminal(input: unknown): NoiseJob["terminal"] {
  if (input === null) return null;
  const value = exactSerialRecord(input, ["outcome", "decidedAtUs"]);
  return { outcome: noiseEnum(value.outcome, NOISE_OUTCOMES), decidedAtUs: maybeNoiseUInt(value.decidedAtUs) };
}
function job(input: unknown): NoiseJob {
  const value = exactSerialRecord(input, ["attemptId", "inputSha256", "bootOrdinal", "workerGeneration", "transportEpoch", "admittedAtUs", "authorityDeadlineUs", "localSocketPort", "stages", "firstFailure", "terminal", "resources"]);
  const result: NoiseJob = {
    attemptId: noiseAttemptId(value.attemptId), inputSha256: noiseDigest(value.inputSha256), bootOrdinal: noisePositive(value.bootOrdinal), workerGeneration: noiseUInt(value.workerGeneration), transportEpoch: noiseUInt(value.transportEpoch),
    admittedAtUs: noiseUInt(value.admittedAtUs), authorityDeadlineUs: noiseUInt(value.authorityDeadlineUs), localSocketPort: value.localSocketPort === null ? null : noisePort(value.localSocketPort),
    stages: stages(value.stages), firstFailure: maybeFailure(value.firstFailure), terminal: maybeTerminal(value.terminal), resources: release(value.resources),
  };
  if (result.authorityDeadlineUs - result.admittedAtUs !== 120_000_000) throw serialFailure("noise_authority_deadline");
  for (const stage of result.stages) if (stage.atUs !== null && stage.atUs < result.admittedAtUs) throw serialFailure("noise_stage_before_admission");
  if (result.stages.some(stage => stage.stage === "tcp_connected") && result.localSocketPort === null) throw serialFailure("noise_socket_tuple");
  requireJobConsistency(result);
  if (result.terminal?.outcome === "accepted") requireAccepted(result);
  else if (result.terminal !== null && result.firstFailure === null) throw serialFailure("noise_missing_failure");
  return result;
}
function clockFailed(value: NoiseJob): boolean {
  return value.firstFailure?.category === "clock_invalid" || value.resources.failure?.category === "clock_invalid";
}
function requireJobConsistency(value: NoiseJob): void {
  const invalidClock = clockFailed(value);
  let previousTime = value.admittedAtUs;
  for (const stage of value.stages) {
    if ((stage.atUs === null || stage.durationUs === null) && (!invalidClock || !["socket_closed", "worker_quiescent"].includes(stage.stage))) throw serialFailure("noise_missing_timing");
    if (stage.atUs !== null && stage.durationUs !== null && stage.stage !== "worker_quiescent" && stage.atUs - stage.durationUs < previousTime) throw serialFailure("noise_operation_order");
    if (stage.atUs !== null && value.firstFailure?.atUs !== undefined && value.firstFailure.atUs !== null && stage.atUs > value.firstFailure.atUs && !["socket_closed", "worker_quiescent"].includes(stage.stage)) throw serialFailure("noise_progress_after_failure");
    if (stage.atUs !== null) previousTime = stage.atUs;
  }
  for (const maybeFailure of [value.firstFailure, value.resources.failure]) {
    if (maybeFailure?.atUs === null && !invalidClock) throw serialFailure("noise_missing_failure_time");
  }
  const maybeTerminal = value.terminal;
  if (!maybeTerminal) return;
  if (maybeTerminal.decidedAtUs === null && !invalidClock) throw serialFailure("noise_missing_terminal_time");
  if (maybeTerminal.decidedAtUs !== null && !invalidClock && ((maybeTerminal.outcome !== "incomplete" && maybeTerminal.decidedAtUs < previousTime) || (value.firstFailure?.atUs !== undefined && value.firstFailure.atUs !== null && value.firstFailure.atUs > maybeTerminal.decidedAtUs))) throw serialFailure("noise_terminal_order");
  if (maybeTerminal.outcome === "accepted") return;
  if (!value.firstFailure) throw serialFailure("noise_missing_failure");
  if (maybeTerminal.outcome === "incomplete") {
    if (!value.resources.failure || value.resources.deadlineMet !== false) throw serialFailure("noise_incomplete_cleanup");
    return;
  }
  if (value.resources.socketState === "open" || value.resources.workerState === "running" || !value.resources.volatileInputsDisposed || value.resources.deadlineMet !== true) throw serialFailure("noise_terminal_cleanup");
  const detail = value.firstFailure.detail;
  if (detail === "timeout" && ["preparation", "connect", "read", "write"].includes(value.firstFailure.category)) {
    // Socket/protocol timeout and aggregate deadline expiry need independent measured evidence.
    if (!["rejected", "expired"].includes(maybeTerminal.outcome)) throw serialFailure("noise_terminal_cause");
    return;
  }
  const outcome = detail === "heartbeat_expired" || (detail === "timeout" && value.firstFailure.category === "authority_lost") ? "expired" : ["cancel_requested", "session_replaced"].includes(detail) ? "cancelled" : "rejected";
  if (maybeTerminal.outcome !== outcome) throw serialFailure("noise_terminal_cause");
}
function requireAccepted(value: NoiseJob): void {
  const resources = value.resources, maybeDecided = value.terminal?.decidedAtUs;
  if (value.firstFailure !== null || resources.failure !== null || value.stages.length !== 8 || maybeDecided === undefined || maybeDecided === null || maybeDecided < value.admittedAtUs || maybeDecided > value.authorityDeadlineUs || resources.socketState !== "closed" || resources.workerState !== "quiescent" || !resources.volatileInputsDisposed || resources.deadlineMet !== true || resources.releasedAtUs === null || resources.releasedAtUs > maybeDecided) throw serialFailure("noise_accepted_proof");
  for (const stage of value.stages) {
    if (stage.atUs === null || stage.durationUs === null || stage.atUs > maybeDecided || stage.atUs - stage.durationUs < value.admittedAtUs) throw serialFailure("noise_accepted_timing");
    const bounds: Partial<Record<NoiseStage, number>> = { noise_prepared: 60_000_000, tcp_connected: 5_000_000, act_one_written: 2_000_000, act_two_received: 10_000_000, proof_written: 2_000_000, worker_quiescent: 5_000_000 };
    const maybeBound = bounds[stage.stage];
    if (maybeBound !== undefined && stage.durationUs > maybeBound) throw serialFailure("noise_operation_deadline");
    const transferBytes: Partial<Record<NoiseStage, number>> = { act_one_written: 64, act_two_received: NOISE_ACT_TWO_BYTES, proof_written: 22 };
    const maybeBytes = transferBytes[stage.stage];
    if (maybeBytes !== undefined && stage.bytes !== maybeBytes) throw serialFailure("noise_transfer_proof");
    if (stage.stage === "worker_quiescent" && (stage.atUs !== resources.releasedAtUs || resources.startedAtUs === null || stage.durationUs !== stage.atUs - resources.startedAtUs)) throw serialFailure("noise_join_timing");
  }
}
/** Parses a closed private projection. No arbitrary log/error payload enters this boundary. */
export function parseNoiseStatus(input: unknown): NoiseStatus {
  const value = exactSerialRecord(input, ["schema", "state", "observation", "job"]);
  if (value.schema !== "worker-noise-diagnostic-status-v1") throw serialFailure("noise_schema");
  const observed = exactSerialRecord(value.observation, ["bootOrdinal", "workerGeneration", "transportEpoch", "observedAtUs", "stationIpv4", "wifiConnected"]);
  const observation = { bootOrdinal: noisePositive(observed.bootOrdinal), workerGeneration: noiseUInt(observed.workerGeneration), transportEpoch: noiseUInt(observed.transportEpoch), observedAtUs: noiseUInt(observed.observedAtUs), stationIpv4: observed.stationIpv4 === null ? null : noisePrivateIpv4(observed.stationIpv4), wifiConnected: noiseBoolean(observed.wifiConnected) };
  if (!observation.wifiConnected && observation.stationIpv4 !== null) throw serialFailure("noise_network_state");
  const state = noiseEnum(value.state, ["idle", "admitted", "running", "cancelling", "terminal"]), maybeJob = value.job === null ? null : job(value.job);
  if ((state === "idle") !== (maybeJob === null) || (maybeJob !== null && ((state === "terminal") !== (maybeJob.terminal !== null)))) throw serialFailure("noise_job_state");
  if (maybeJob !== null) {
    if (maybeJob.bootOrdinal !== observation.bootOrdinal) throw serialFailure("noise_boot_binding");
    if (["admitted", "running"].includes(state) && (maybeJob.workerGeneration !== observation.workerGeneration || maybeJob.transportEpoch !== observation.transportEpoch)) throw serialFailure("noise_live_binding");
    if (!clockFailed(maybeJob) && [maybeJob.admittedAtUs, ...maybeJob.stages.map(stage => stage.atUs), maybeJob.terminal?.decidedAtUs, maybeJob.firstFailure?.atUs, maybeJob.resources.releasedAtUs].some(time => time !== null && time !== undefined && time > observation.observedAtUs)) throw serialFailure("noise_observation_order");
  }
  return { schema: value.schema, state, observation, job: maybeJob };
}
