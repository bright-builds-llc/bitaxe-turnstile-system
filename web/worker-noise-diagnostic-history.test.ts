import { expect, test } from "bun:test";
import { WorkerNoiseDiagnosticHistory } from "./worker-noise-diagnostic-history";
import { noiseJob } from "./worker-noise-diagnostic.fixture";

test.each(["open", "closed"] as const)("terminal never-created socket cannot later become %s", socketState => {
  const history = new WorkerNoiseDiagnosticHistory(), original = noiseJob();
  original.firstFailure = { stage: "admission", category: "authority_lost", detail: "cancel_requested", atUs: 1000 };
  original.terminal = { outcome: "cancelled", decidedAtUs: 1000 };
  history.observe(original);
  const changed = structuredClone(original); changed.resources.socketState = socketState;
  expect(() => history.observe(changed)).toThrow("noise_terminal_owner_creation");
});
test.each(["running", "quiescent"] as const)("terminal never-started worker cannot later become %s", workerState => {
  const history = new WorkerNoiseDiagnosticHistory(), original = noiseJob();
  original.firstFailure = { stage: "admission", category: "authority_lost", detail: "cancel_requested", atUs: 1000 };
  original.terminal = { outcome: "cancelled", decidedAtUs: 1000 };
  history.observe(original);
  const changed = structuredClone(original); changed.resources.workerState = workerState;
  expect(() => history.observe(changed)).toThrow("noise_terminal_owner_creation");
});
test("latched failure forbids new protocol progress even before terminal cleanup", () => {
  const history = new WorkerNoiseDiagnosticHistory(), original = noiseJob();
  original.firstFailure = { stage: "admission", category: "authority_lost", detail: "heartbeat_expired", atUs: 1000 };
  history.observe(original);
  const changed = structuredClone(original); changed.stages.push({ stage: "noise_prepared", sequence: 1, atUs: 2000, durationUs: 1000, bytes: null });
  expect(() => history.observe(changed)).toThrow("noise_terminal_progress");
});
