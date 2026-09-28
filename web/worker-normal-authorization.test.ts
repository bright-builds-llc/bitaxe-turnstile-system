import { expect, test } from "bun:test";
import { WorkerAuthorizationRecoveryCheckpoint } from "./worker-authorization-recovery";
import { runWorkerNormalAuthorization } from "./worker-normal-authorization";
import { parseWorkerControllerStatus } from "./worker-controller";
import { parseWorkerPreservation } from "./worker-preservation";
import { progressFixture } from "./worker-mining-progress.fixture";
import { miningInterruptionFixture } from "./worker-mining-interruption.fixture";
import { serialHarness } from "./worker-serial.test-support";
import { createWebSerialWorkerController, workerSerialQualificationHook } from "./webserial-worker-controller";

const preservation = (hash: string) => parseWorkerPreservation({ schema: "worker-preservation-v1", settings_sha256: "1".repeat(64), authorization_high_water_sha256: hash, device_identity_sha256: "3".repeat(64), mine_on_boot: false });
const mining = (generation = 7) => parseWorkerControllerStatus({ protocolVersion: "bwg-worker-controller/0.4", state: "mining", monotonicMilliseconds: 1,
  lease: { leaseId: "lease", challengeId: "challenge", renewAtMonotonicMilliseconds: 20001, expiresAtMonotonicMilliseconds: 60001 },
  restoration: { status: "pending" }, qualification: { ...miningInterruptionFixture, generation, mining_progress: { ...progressFixture, generation } } });
function observe(checkpoint: WorkerAuthorizationRecoveryCheckpoint, hash: string, generation = 7) {
  checkpoint.observePreservation(preservation(hash)); checkpoint.observeStatus(mining(generation));
}

test("authorization completion cannot reuse a stale earlier status or a mismatched operation token", () => {
  // Arrange
  const checkpoint = new WorkerAuthorizationRecoveryCheckpoint(); checkpoint.beginSession(); observe(checkpoint, "2".repeat(64));
  const token = checkpoint.beginAuthorizedOperation();
  // Act / Assert
  expect(() => checkpoint.completeAuthorizedOperation(token)).toThrow("authorization_recovery_boundary");
  observe(checkpoint, "f".repeat(64));
  expect(() => checkpoint.completeAuthorizedOperation({ ...token })).toThrow("authorization_recovery_boundary");
  checkpoint.completeAuthorizedOperation(token);
  expect(() => checkpoint.captureNormalStop()).toThrow("authorization_recovery_normal_stop");
});
test("missing private authorization response runs cleanup and does not create an expected checkpoint", async () => {
  const checkpoint = new WorkerAuthorizationRecoveryCheckpoint(); checkpoint.beginSession();
  let cleaned = false;
  await expect(runWorkerNormalAuthorization(checkpoint, true, async () => checkpoint.observeStatus(mining()), async () => { cleaned = true; })).rejects.toThrow("authorization_recovery_boundary");
  expect(cleaned).toBeTrue(); expect(checkpoint.maybePublicState()).toBeUndefined();
  expect(() => checkpoint.clearForResume(false)).toThrow("authorization_recovery_unsealed");
});
test("a renewal cannot silently switch retained work generation", () => {
  const checkpoint = new WorkerAuthorizationRecoveryCheckpoint(); checkpoint.beginSession();
  const start = checkpoint.beginAuthorizedOperation(); observe(checkpoint, "f".repeat(64)); checkpoint.completeAuthorizedOperation(start);
  const renew = checkpoint.beginAuthorizedOperation(); observe(checkpoint, "e".repeat(64), 8);
  expect(() => checkpoint.completeAuthorizedOperation(renew)).toThrow("authorization_recovery_boundary");
});
test("cleanup failure retains the original authorization failure", async () => {
  const checkpoint = new WorkerAuthorizationRecoveryCheckpoint(), failure = Error("original"); checkpoint.beginSession();
  const error = await runWorkerNormalAuthorization(checkpoint, true, async () => { throw failure; }, async () => { throw Error("cleanup"); }).catch(value => value);
  expect(error).toBeInstanceOf(AggregateError); expect(error.errors[0]).toBe(failure);
});
test("actual signed renewal updates the private expected high-water before normal restoration and reconnect", async () => {
  // Arrange
  const h = await serialHarness(), checkpoint = new WorkerAuthorizationRecoveryCheckpoint();
  const input = { ...h.input, [workerSerialQualificationHook]: { suppressHeartbeats: false,
    observePreservation: (value: ReturnType<typeof parseWorkerPreservation>) => checkpoint.observePreservation(value),
    observeStatus: (value: Parameters<typeof checkpoint.observeStatus>[0]) => checkpoint.observeStatus(value) } };
  const controller = createWebSerialWorkerController(input); h.setQualification(miningInterruptionFixture);
  checkpoint.beginSession(); await controller.requestPermission();
  const context = await controller.prepareWorkerLeaseAuthorizationContext("start"), grant = await h.grant(context), renewal = await h.renewal(context);
  try {
    // Act
    h.alterPreservation("authorization_high_water_sha256");
    await runWorkerNormalAuthorization(checkpoint, true, () => controller.startLease(grant), () => controller.close());
    h.alterPreservation("authorization_high_water_sha256", "e".repeat(64));
    await runWorkerNormalAuthorization(checkpoint, true, () => controller.renewLease(renewal), () => controller.close());
    await controller.restore("cancelled"); checkpoint.captureNormalStop(); const pending = checkpoint.maybePublicState();
    await controller.close(); checkpoint.beginSession(); await controller.requestPermission();
    // Assert
    expect(pending?.matched).toBeNull(); expect(checkpoint.maybePublicState()).toMatchObject({ checkpointId: pending?.checkpointId, generation: 7, matched: true });
    expect(h.received.filter(row => row.command === "renew_lease")).toHaveLength(1);
    expect(JSON.stringify(checkpoint.maybePublicState())).not.toContain("e".repeat(64));
  } finally { await controller.close(); }
});
