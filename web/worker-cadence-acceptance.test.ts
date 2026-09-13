import { expect, test } from "bun:test";
import { WorkerCadenceAcceptance, runWorkerCadenceUsbPhase } from "./worker-cadence-acceptance";
import { miningInterruptionFixture } from "./worker-mining-interruption.fixture";
import type { WorkerControllerStatus } from "./worker-controller";
const arm = { schema: "worker-telemetry-cadence-arm-v1", phase: "mining", generation: 7, armedAtUs: 10 } as const;
function mining(workDispatched = 1): WorkerControllerStatus {
  return { protocolVersion: "bwg-worker-controller/0.4", state: "mining", monotonicMilliseconds: 1,
    lease: { leaseId: "fixture-lease", challengeId: "fixture-challenge", renewAtMonotonicMilliseconds: 1000, expiresAtMonotonicMilliseconds: 10000 },
    restoration: { status: "pending" }, qualification: { ...miningInterruptionFixture, active_limit_ms: 180000, work_dispatched: workDispatched,
      attempt: { schema: "worker-qualification-observation-v1", ordinal: 16, purpose: "normal", maximum_active_ms: 180000, reserved_ms: 180000, complete: false, active_ms: 10 } } };
}
function owner() { const value = new WorkerCadenceAcceptance(); value.configure(true); value.arm(arm); return value; }
test("cadence mode cannot downgrade or rearm a mining phase", () => {
  const value = owner();
  expect(() => value.configure(undefined)).toThrow("cadence_mode_downgrade");
  expect(() => value.arm(arm)).toThrow("cadence_mining_consumed");
});
test("cadence suppression waits sixty seconds plus the boundary tail from real observed work and consumes once", () => {
  // Arrange
  const value = owner(); value.observe(mining(0), 1000);
  expect(value.shouldSuppress(100000)).toBeFalse();
  // Act
  value.observe(mining(1), 10000); value.observe(mining(30), 71999);
  // Assert
  expect(value.shouldSuppress(71999)).toBeFalse();
  expect(value.shouldSuppress(72000)).toBeTrue();
  value.suppress(72000, () => undefined);
  expect(value.state().suppressionRequested).toBeTrue();
  expect(() => value.suppress(72001, () => undefined)).toThrow();
});
test("stale work cannot trigger planned heartbeat suppression", () => {
  const value = owner(); value.observe(mining(), 1);
  expect(() => value.suppress(62001, () => undefined)).toThrow("cadence_suppression_admission");
});
test("a different generation cannot complete the mining capture", () => {
  const value = owner(); const status = mining(); status.qualification!.generation = 8;
  expect(() => value.observe(status, 1)).toThrow("cadence_generation_mismatch");
});
test("metadata-only cadence page state omits unobserved fields", () => {
  const value = owner();
  expect(value.state()).toEqual({ schema: "worker-cadence-browser-v1", enabled: true, suppressionRequested: false });
  expect(() => value.requireIdle(true, false)).toThrow();
  expect(() => value.requireIdle(false, true)).toThrow();
});
test("USB probes remain serialized on the five-second schedule", async () => {
  // Arrange
  let now = 10; let inFlight = false; const saved: number[] = [];
  // Act
  const result = await runWorkerCadenceUsbPhase({ now: () => now, wait: async ms => { now += ms; },
    probe: async () => { expect(inFlight).toBeFalse(); inFlight = true; now += 20; await Promise.resolve(); inFlight = false; return { requestPayloadBytes: 65536, responsePayloadBytes: 65536 }; },
    record: async receipt => { saved.push(receipt.ordinal); },
  });
  // Assert
  expect(saved).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
  expect(result.probes.map(value => value.startedAtMs)).toEqual(Array.from({ length: 12 }, (_, index) => 10 + index * 5000));
});
test("a slow USB response stops the phase without catch-up traffic", async () => {
  let now = 0; let count = 0;
  await expect(runWorkerCadenceUsbPhase({ now: () => now, wait: async ms => { now += ms; },
    probe: async () => { count += 1; now += 5000; return { requestPayloadBytes: 65536, responsePayloadBytes: 65536 }; }, record: async () => undefined,
  })).rejects.toThrow("cadence_probe_incomplete");
  expect(count).toBe(1);
});

test("loss of work after first dispatch cannot reuse a fresh-looking old observation", () => {
  const value = owner(); value.observe(mining(), 1);
  expect(() => value.observe({ protocolVersion: "bwg-worker-controller/0.4", state: "baseline", monotonicMilliseconds: 2, restoration: { status: "not_required" } }, 62001)).toThrow("cadence_work_lost");
  expect(() => value.suppress(62001, () => undefined)).toThrow();
});

test("failed preservation capture cannot be mistaken for intentional heartbeat suppression", () => {
  const value = owner(); value.observe(mining(), 1); value.observe(mining(30), 62001);
  expect(() => value.suppress(62001, () => { throw new Error("checkpoint_missing"); })).toThrow("checkpoint_missing");
  expect(value.state().suppressionRequested).toBeFalse();
});
test("cadence captures post-work replay state and verifies it only after fresh reconnection", async () => {
  // Arrange
  const { WorkerAuthorizationRecoveryCheckpoint } = await import("./worker-authorization-recovery");
  const { WorkerPreservationBaseline, parseWorkerPreservation } = await import("./worker-preservation");
  const checkpoint = new WorkerAuthorizationRecoveryCheckpoint(), original = new WorkerPreservationBaseline(), value = owner();
  const snapshot = (hash: string) => parseWorkerPreservation({ schema: "worker-preservation-v1", settings_sha256: "1".repeat(64), authorization_high_water_sha256: hash, device_identity_sha256: "3".repeat(64), mine_on_boot: false });
  original.observe(snapshot("2".repeat(64))); checkpoint.beginSession();
  original.observe(snapshot("f".repeat(64))); checkpoint.observePreservation(snapshot("f".repeat(64))); checkpoint.observeStatus(mining(30));
  value.observe(mining(), 1); value.observe(mining(30), 62001);
  // Act
  value.suppress(62001, () => checkpoint.capture(7));
  expect(checkpoint.maybePublicState()?.matched).toBeNull();
  checkpoint.beginSession(); checkpoint.observePreservation(snapshot("f".repeat(64))); checkpoint.observeStatus(mining(30));
  // Assert
  expect(checkpoint.maybePublicState()?.matched).toBeTrue();
  expect(original.maybePublicState()?.authorization_high_water_match).toBeFalse();
  expect(value.state().suppressionRequested).toBeTrue();
});


test("fractional browser monotonic observations publish integer milliseconds", () => {
  const value = owner(); value.observe(mining(), 10.875); value.observe(mining(30), 62010.875);
  expect(value.state()).toMatchObject({ firstWorkObservedAtMs: 10, latestWork: { atMs: 62010, generation: 7, workDispatched: 30 } });
  expect(value.shouldSuppress(62009.999)).toBeFalse();
  value.suppress(62010.875, () => undefined);
  expect(value.state().suppressionRequested).toBeTrue();
});

test("fractional performance clock preserves integer five-second probe schedules", async () => {
  let now = 10.875;
  const result = await runWorkerCadenceUsbPhase({ now: () => now, wait: async ms => { now += ms; },
    probe: async () => { now += 20.125; return { requestPayloadBytes: 65536, responsePayloadBytes: 65536 }; }, record: async () => undefined,
  });
  expect(result.probes.map(value => value.scheduledAtMs)).toEqual(Array.from({ length: 12 }, (_, index) => 10 + index * 5000));
  expect(result.probes.every(value => [value.scheduledAtMs, value.startedAtMs, value.completedAtMs].every(Number.isSafeInteger))).toBeTrue();
});
