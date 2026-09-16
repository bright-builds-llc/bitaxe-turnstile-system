/** Prospective str005-noise-serial-v1 private wire metadata; never public diagnostics. */
export const NOISE_STAGES = ["noise_prepared", "tcp_connected", "act_one_written", "act_two_received", "authority_verified", "proof_written", "socket_closed", "worker_quiescent"] as const;
export type NoiseStage = typeof NOISE_STAGES[number];
export const NOISE_FAILURE_STAGES = [...NOISE_STAGES, "admission", "fixture_ready", "candidate_inventory", "proof_received", "cleanup", "evidence"] as const;
export const NOISE_CATEGORIES = ["preparation", "connect", "write", "read", "authentication", "proof", "authority_lost", "clock_invalid", "cleanup", "evidence_incomplete"] as const;
export const NOISE_DETAILS = ["timeout", "eof", "partial", "extra", "malformed", "io", "wrong_authority", "certificate_time", "session_replaced", "heartbeat_expired", "cancel_requested", "clock_discontinuity", "delivery_ambiguous", "resource_unreleased", "identity_conflict", "peer_conflict", "overflow", "missing", "stale", "duplicate", "rng", "allocation", "before_epoch", "time_overflow"] as const;
export const NOISE_OUTCOMES = ["accepted", "rejected", "cancelled", "expired", "incomplete"] as const;
export type NoiseCause = { stage: typeof NOISE_FAILURE_STAGES[number]; category: typeof NOISE_CATEGORIES[number]; detail: typeof NOISE_DETAILS[number] };
export type NoiseDeviceFailure = NoiseCause & { atUs: number | null };
export type NoiseStageObservation = { stage: NoiseStage; sequence: number; atUs: number | null; durationUs: number | null; bytes: number | null };
export type NoiseRelease = {
  socketState: "not_created" | "open" | "closed"; workerState: "not_started" | "running" | "quiescent";
  volatileInputsDisposed: boolean; startedAtUs: number | null; deadlineAtUs: number | null;
  releasedAtUs: number | null; deadlineMet: boolean | null; failure: NoiseDeviceFailure | null;
};
export type NoiseJob = {
  attemptId: string; inputSha256: string; bootOrdinal: number; workerGeneration: number; transportEpoch: number;
  admittedAtUs: number; authorityDeadlineUs: number; localSocketPort: number | null;
  stages: NoiseStageObservation[]; firstFailure: NoiseDeviceFailure | null;
  terminal: { outcome: typeof NOISE_OUTCOMES[number]; decidedAtUs: number | null } | null; resources: NoiseRelease;
};
export type NoiseStatus = {
  schema: "worker-noise-diagnostic-status-v1";
  state: "idle" | "admitted" | "running" | "cancelling" | "terminal";
  observation: { bootOrdinal: number; workerGeneration: number; transportEpoch: number; observedAtUs: number; stationIpv4: string | null; wifiConnected: boolean };
  job: NoiseJob | null;
};
export type NoiseStartInput = {
  schema: "worker-noise-diagnostic-start-v1"; attemptId: string; expectedBootOrdinal: number;
  networkObservedAtUs: number; fixtureIpv4: string; fixturePort: number; authorityPublicKey: string;
};
