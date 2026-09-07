import { expect, test } from "bun:test";
import { parseQualificationCoolingResult } from "./worker-qualification-cooling";
import { serialHarness } from "./worker-serial.test-support";
import { createWebSerialWorkerController, workerSerialQualificationHook } from "./webserial-worker-controller";
import { decodeWorkerControllerSerialRequest, encodeWorkerControllerSerialMessage } from "./worker-controller-serial";
const proof = { schema: "worker-cooling-proof-v1", fan_duty_percent: 100, fan_rpm: 4200, post_command_fan_proven: true, asic_effects: false, budget_reserved: false };

test("fan qualification rejects unproven RPM, ASIC effects, reservations and extra data", () => {
  // Arrange
  const invalid = [{ ...proof, fan_rpm: 0 }, { ...proof, fan_rpm: 65536 }, { ...proof, fan_rpm: 1.5 }, { ...proof, asic_effects: true }, { ...proof, budget_reserved: true }, { ...proof, post_command_fan_proven: false }, { ...proof, extra: "private" }];
  // Act / Assert
  for (const value of invalid) expect(() => parseQualificationCoolingResult("prove_fan", value)).toThrow();
});
test("public cooling codec accepts only the two closed actions", () => {
  // Arrange
  const request = { protocolVersion: "bwg-worker-controller/0.4", requestId: "serial_cooling", command: "qualification_cooling" };
  // Act / Assert
  for (const action of ["prove_fan", "restore_baseline"]) expect(decodeWorkerControllerSerialRequest(encodeWorkerControllerSerialMessage({ ...request, payload: { action } })).command).toBe("qualification_cooling");
  for (const payload of [{ action: "private" }, { action: "prove_fan", extra: "private" }, {}]) expect(() => decodeWorkerControllerSerialRequest(encodeWorkerControllerSerialMessage({ ...request, payload }))).toThrow();
});
test("actual adapter proves and restores cooling without lease or signer and requires fresh possession afterward", async () => {
  // Arrange
  const h = await serialHarness();
  const observed: unknown[] = [];
  Object.assign(h.input, { [workerSerialQualificationHook]: { suppressHeartbeats: false, observeStatus: (value: unknown) => observed.push(value) } });
  const controller = createWebSerialWorkerController(h.input);
  await controller.requestPermission();
  try {
    // Act
    const proven = await controller.qualificationCooling("prove_fan");
    // Assert
    expect(proven.schema).toBe("worker-cooling-proof-v1");
    expect(observed.at(-1)).toBeUndefined();
    expect(h.counts().active).toBeFalse();
    expect(h.received.some(value => value.command === "start_lease")).toBeFalse();
    const restored = await controller.qualificationCooling("restore_baseline");
    expect(restored.schema).toBe("worker-cooling-baseline-v1");
    expect(observed.at(-1)).toMatchObject({ state: "baseline", restoration: { status: "confirmed" } });
    await expect(controller.acceptanceBudgetReview("AAAAAAAAAAAAAAAAAAAAAA")).rejects.toThrow();
    await controller.prepareWorkerLeaseAuthorizationContext("start");
    expect((await controller.acceptanceBudgetReview("AAAAAAAAAAAAAAAAAAAAAA")).charged_ms).toBe(180000);
  } finally { await controller.close(); }
});
test("ordinary adapter cannot invoke qualification cooling without the explicit hook", async () => {
  const h = await serialHarness();
  await h.controller.requestPermission();
  try { await expect(h.controller.qualificationCooling("prove_fan")).rejects.toThrow(); }
  finally { await h.controller.close(); }
});

test("fan restoration receipt cannot replace a missing baseline status confirmation", async () => {
  // Arrange
  const { runQualificationCooling } = await import("./worker-qualification-cooling");
  const failures: Error[] = [];
  const receipt = { schema: "worker-cooling-baseline-v1", fan_duty_percent: 30, cooling_proven: true, asic_effects: false, budget_reserved: false };
  let invalidated = false;
  // Act / Assert
  await expect(runQualificationCooling("restore_baseline", {
    prove: async () => undefined,
    request: async () => receipt,
    invalidate: value => { invalidated = value; },
    status: async () => ({ protocolVersion: "bwg-worker-controller/0.4", state: "baseline", monotonicMilliseconds: 1, restoration: { status: "not_required" } }),
    failed: error => failures.push(error),
  })).rejects.toThrow();
  expect(invalidated).toBeTrue();
  expect(failures).toHaveLength(1);
});
