import { expect, test } from "bun:test";
import { parseWorkerControllerStatus } from "./worker-controller";
const qualification = {
  schema: "worker-qualification-v1",
  revocation_reason: "none",
  active_limit_ms: null,
  shutdown_budget_ms: 15550,
  work_gate_remaining_ms: null,
  generation: 1,
  active_ms: 10,
  generation_elapsed_ms: 15,
  budget_reserved_ms: 180000,
  budget_complete: false,
  submitted: 0,
  accepted: 0,
  rejected: 0,
  nonce_work_correlations: 0,
  work_dispatched: 0,
  last_valid_heartbeat_ms: 0,
  gate_closed_ms: null,
  shutdown_started_ms: null,
  safe_stop_stage: "not_started",
  safe_stop_complete: false,
  voltage_volts: null,
  power_watts: null,
  chip_temp_celsius: null,
  fan_rpm: null,
  voltage_fresh: false,
  power_fresh: false,
  temperature_fresh: false,
  fan_fresh: false,
  watchdog_alive: true,
  mine_on_boot: false,
};
const baseline = {
  protocolVersion: "bwg-worker-controller/0.4",
  state: "baseline",
  monotonicMilliseconds: 100,
  restoration: { status: "confirmed", reason: "paused" },
};
test("status preserves closed qualification without using it as lease authority", () => {
  // Arrange / Act
  const parsed = parseWorkerControllerStatus({ ...baseline, qualification });
  // Assert
  expect(parsed.qualification?.schema).toBe("worker-qualification-v1");
  expect(parsed.state).toBe("baseline");
});
test("status rejects unknown telemetry, nonfinite samples, and false freshness", () => {
  // Arrange / Act / Assert
  for (const invalid of [
    { ...qualification, secret: "value" },
    { ...qualification, voltage_volts: NaN },
    { ...qualification, voltage_fresh: true },
    { ...qualification, gate_closed_ms: -1 },
  ])
    expect(() =>
      parseWorkerControllerStatus({ ...baseline, qualification: invalid }),
    ).toThrow();
});

test("qualification admits only the closed winning revocation attribution", () => {
  // Arrange / Act / Assert
  for (const reason of [
    "none",
    "heartbeat_timeout",
    "lease_or_budget_expired",
    "restoration_requested",
    "unsafe_observation",
    "link_closed",
    "control_failed",
  ] as const)
    expect(
      parseWorkerControllerStatus({
        ...baseline,
        qualification: { ...qualification, revocation_reason: reason },
      }).qualification?.revocation_reason,
    ).toBe(reason);
  expect(() =>
    parseWorkerControllerStatus({
      ...baseline,
      qualification: { ...qualification, revocation_reason: "private-detail" },
    }),
  ).toThrow();
});

test("attempt telemetry keeps legacy accounting separate and requires exact active time", () => {
  // Arrange
  const attempt = { schema: "worker-qualification-observation-v1", ordinal: 1, purpose: "diagnostic", maximum_active_ms: 30000, reserved_ms: 30000, complete: false, active_ms: 10 };
  const observation = { ...qualification, budget_reserved_ms: 240000, budget_complete: true, attempt };
  // Act / Assert
  const parsed = parseWorkerControllerStatus({ ...baseline, qualification: observation });
  expect(parsed.qualification?.budget_reserved_ms).toBe(240000);
  expect(parsed.qualification?.attempt?.reserved_ms).toBe(30000);
  expect(() => parseWorkerControllerStatus({ ...baseline, qualification: { ...observation, attempt: { ...attempt, active_ms: 11 } } })).toThrow();
  expect(() => parseWorkerControllerStatus({ ...baseline, qualification: { ...observation, attempt: { ...attempt, id: "private" } } })).toThrow();
});

test("iterative running requires current active owner resources with at least 4096 stack bytes", async () => {
  // Arrange
  const { requireWorkerOwnerHeadroom } = await import("./worker-owner-resources");
  const { parseWorkerLeaseGrant } = await import("./worker-controller");
  const { default: vectors } = await import("../conformance/bwg-worker-controller-0.4/qualification-attempt-vectors.json");
  const grant = parseWorkerLeaseGrant(vectors.vectors[0]!.grant);
  const owner_resources = { schema: "worker-owner-resources-v1", generation: 1, phase: "active", observed_at_ms: "100", heap_free_bytes: 8000, heap_largest_bytes: 6000, stack_free_bytes: 4096 };
  const observed = parseWorkerControllerStatus({ ...baseline, qualification: { ...qualification, owner_resources } }).qualification;
  // Act / Assert
  expect(() => requireWorkerOwnerHeadroom(grant, observed)).not.toThrow();
  for (const change of [{ stack_free_bytes: 28 }, { stack_free_bytes: 4095 }, { phase: "preparation" }]) {
    const changed = parseWorkerControllerStatus({ ...baseline, qualification: { ...qualification, owner_resources: { ...owner_resources, ...change } } }).qualification;
    expect(() => requireWorkerOwnerHeadroom(grant, changed)).toThrow("window_control_failed");
  }
});

test("failed owner resource evidence is retained independently of subsequent observations", async () => {
  // Arrange
  const { workerOwnerResourceFailure } = await import("./worker-owner-resources");
  const owner_resources = { schema: "worker-owner-resources-v1", generation: 1, phase: "active", observed_at_ms: "100", heap_free_bytes: 8000, heap_largest_bytes: 6000, stack_free_bytes: 28 };
  const observed = parseWorkerControllerStatus({ ...baseline, qualification: { ...qualification, owner_resources } }).qualification;
  // Act
  const failure = workerOwnerResourceFailure(observed);
  if (observed?.owner_resources) observed.owner_resources.stack_free_bytes = 4096;
  // Assert
  expect(failure.resources?.stack_free_bytes).toBe(28);
  expect(Object.isFrozen(failure)).toBeTrue();
  expect(Object.isFrozen(failure.resources)).toBeTrue();
  expect(workerOwnerResourceFailure(undefined)).toEqual({ schema: "worker-owner-resource-failure-v1", generation: null, resources: null });
});

test("mining progress remains optional and is validated when present", async () => {
  // Arrange
  const { progressFixture } = await import("./worker-mining-progress.fixture");
  // Act
  const historical = parseWorkerControllerStatus({ ...baseline, qualification }).qualification;
  // Assert
  expect(historical?.mining_progress).toBeUndefined();
  const current = parseWorkerControllerStatus({ ...baseline, qualification: { ...qualification, mining_progress: { ...progressFixture, generation: qualification.generation } } }).qualification;
  expect(current?.mining_progress?.below_pool_target).toBe("7");
  expect(current?.nonce_work_correlations).toBe(0);
});
