import type { WorkerQualification } from "./worker-qualification";
import { progressFixture } from "./worker-mining-progress.fixture";

/** Public synthetic status, derived from the existing qualification/parser fixtures. */
export const miningInterruptionFixture: WorkerQualification = {
  schema: "worker-qualification-v1", revocation_reason: "none", active_limit_ms: 30000,
  shutdown_budget_ms: 15550, work_gate_remaining_ms: 12000, generation: 7,
  active_ms: 10, generation_elapsed_ms: 15, budget_reserved_ms: 180000,
  budget_complete: true, submitted: 0, accepted: 0, rejected: 0, nonce_work_correlations: 0,
  work_dispatched: 1, last_valid_heartbeat_ms: 0, gate_closed_ms: null, shutdown_started_ms: null,
  safe_stop_stage: "not_started", safe_stop_complete: false, voltage_volts: null, power_watts: null,
  chip_temp_celsius: null, fan_rpm: null, voltage_fresh: false, power_fresh: false,
  temperature_fresh: false, fan_fresh: false, watchdog_alive: true, mine_on_boot: false,
  attempt: { schema: "worker-qualification-observation-v1", ordinal: 1, purpose: "diagnostic", maximum_active_ms: 30000, reserved_ms: 30000, complete: false, active_ms: 10 },
  mining_progress: { ...progressFixture, schema: "worker-mining-progress-v1", generation: 7 },
};
