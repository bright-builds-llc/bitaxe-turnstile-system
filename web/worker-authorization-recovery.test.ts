import { expect, test } from "bun:test";
import { WorkerAuthorizationRecoveryCheckpoint } from "./worker-authorization-recovery";
import { WorkerPreservationBaseline, parseWorkerPreservation } from "./worker-preservation";
import { parseWorkerControllerStatus } from "./worker-controller";
import { miningInterruptionFixture } from "./worker-mining-interruption.fixture";
import { serialHarness } from "./worker-serial.test-support";
import { createWebSerialWorkerController, workerSerialQualificationHook } from "./webserial-worker-controller";

const wire = (hash: string) => parseWorkerPreservation({ schema: "worker-preservation-v1", settings_sha256: "1".repeat(64), authorization_high_water_sha256: hash, device_identity_sha256: "3".repeat(64), mine_on_boot: false });
const status = (generation = 7) => parseWorkerControllerStatus({ protocolVersion: "bwg-worker-controller/0.4", state: "baseline", monotonicMilliseconds: 10, restoration: { status: "confirmed", reason: "cancelled" }, qualification: { ...miningInterruptionFixture, generation, mining_progress: { ...miningInterruptionFixture.mining_progress!, generation } } });
function observe(checkpoint: WorkerAuthorizationRecoveryCheckpoint, hash: string, generation = 7) { checkpoint.observePreservation(wire(hash)); checkpoint.observeStatus(status(generation)); }
function captured() { const checkpoint = new WorkerAuthorizationRecoveryCheckpoint(); checkpoint.beginSession(); observe(checkpoint, "f".repeat(64)); checkpoint.capture(7); return checkpoint; }

test("authorized high-water advance has its own checkpoint without resetting the original baseline", () => {
  // Arrange
  const original = new WorkerPreservationBaseline(); const checkpoint = new WorkerAuthorizationRecoveryCheckpoint(); checkpoint.beginSession();
  original.observe(wire("2".repeat(64))); const baselineId = original.maybePublicState()?.baseline_id;
  // Act
  original.observe(wire("f".repeat(64))); observe(checkpoint, "f".repeat(64)); checkpoint.capture(7);
  const pending = checkpoint.maybePublicState(); checkpoint.beginSession(); observe(checkpoint, "f".repeat(64));
  // Assert
  expect(original.maybePublicState()).toMatchObject({ baseline_id: baselineId, authorization_high_water_match: false });
  expect(pending?.matched).toBeNull(); expect(checkpoint.maybePublicState()).toMatchObject({ checkpointId: pending?.checkpointId, generation: 7, matched: true });
  expect(pending?.checkpointId).toMatch(/^[A-Za-z0-9_-]{21}[AQgw]$/u);
  expect(JSON.stringify(checkpoint.maybePublicState())).not.toContain("f".repeat(64));
});

test("replay-state rollback remains a mismatch even if a later status restores the expected digest", () => {
  // Arrange
  const checkpoint = captured(); checkpoint.beginSession();
  // Act
  observe(checkpoint, "2".repeat(64)); observe(checkpoint, "f".repeat(64));
  // Assert
  expect(checkpoint.maybePublicState()?.matched).toBeFalse();
});

test("missing fresh preservation cannot reuse the previous status hash", () => {
  const checkpoint = captured(); checkpoint.beginSession(); checkpoint.observeStatus(status());
  expect(checkpoint.maybePublicState()?.matched).toBeFalse();
});

test("missing or different retained generation is not preserved authorization evidence", () => {
  // Arrange
  const missing = captured(), changed = captured(); missing.beginSession(); changed.beginSession();
  // Act
  missing.observePreservation(wire("f".repeat(64)));
  missing.observeStatus(parseWorkerControllerStatus({ protocolVersion: "bwg-worker-controller/0.4", state: "baseline", monotonicMilliseconds: 10, restoration: { status: "confirmed", reason: "cancelled" } }));
  observe(changed, "f".repeat(64), 8);
  // Assert
  expect(missing.maybePublicState()?.matched).toBeFalse(); expect(changed.maybePublicState()?.matched).toBeFalse();
});

test("capture needs preservation from that exact status and cannot replace a checkpoint", () => {
  const checkpoint = new WorkerAuthorizationRecoveryCheckpoint(); checkpoint.beginSession(); observe(checkpoint, "f".repeat(64)); checkpoint.observeStatus(status());
  expect(() => checkpoint.capture(7)).toThrow();
  observe(checkpoint, "f".repeat(64)); expect(() => checkpoint.capture(8)).toThrow(); checkpoint.capture(7);
  expect(() => checkpoint.capture(7)).toThrow(); expect(() => checkpoint.clearForResume(false)).toThrow();
  checkpoint.clearForResume(true); expect(checkpoint.maybePublicState()).toBeUndefined();
});

test("actual status callbacks keep authorized replay advancement private across reconnect", async () => {
  // Arrange
  const h = await serialHarness(); const original = new WorkerPreservationBaseline(), checkpoint = new WorkerAuthorizationRecoveryCheckpoint();
  const input = { ...h.input, [workerSerialQualificationHook]: { suppressHeartbeats: false,
    observePreservation: (value: ReturnType<typeof parseWorkerPreservation>) => { original.observe(value); checkpoint.observePreservation(value); },
    observeStatus: (value: Parameters<typeof checkpoint.observeStatus>[0]) => checkpoint.observeStatus(value) } };
  const controller = createWebSerialWorkerController(input); checkpoint.beginSession(); await controller.requestPermission();
  h.setQualification(miningInterruptionFixture); const grant = await h.grant(await controller.prepareWorkerLeaseAuthorizationContext("start")); await controller.startLease(grant);
  h.alterPreservation("authorization_high_water_sha256"); await controller.status(); checkpoint.capture(7);
  // Act
  await controller.close(); checkpoint.beginSession(); await controller.requestPermission();
  // Assert
  expect(original.maybePublicState()?.authorization_high_water_match).toBeFalse(); expect(checkpoint.maybePublicState()?.matched).toBeTrue();
  expect(JSON.stringify(checkpoint.maybePublicState())).not.toContain("f".repeat(64)); await controller.close();
});
