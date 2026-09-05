import { expect, test } from "bun:test";
import { parseWorkerControllerStatus } from "./worker-controller";
const qualification = {
  schema: "worker-qualification-v1",
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
