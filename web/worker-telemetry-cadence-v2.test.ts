import { expect, test } from "bun:test";
import { cadenceFixture, cadenceV2Fixture } from "./worker-telemetry-cadence.fixture";
import { CADENCE_LIVE_STAGES, parseWorkerCadenceReview } from "./worker-telemetry-cadence";
import { serialHarness } from "./worker-serial.test-support";
import { createWebSerialWorkerController, workerSerialQualificationHook } from "./webserial-worker-controller";
import { WorkerCadenceAcceptance } from "./worker-cadence-acceptance";

function changePhase(change: Record<string, unknown>) {
  const value = cadenceV2Fixture();
  return { ...value, phases: [{ ...value.phases[0], ...change }, ...value.phases.slice(1)] };
}

test("v2 preserves all eleven stage timings and the worst interval independently", () => {
  // Arrange
  const source = cadenceV2Fixture();
  // Act
  const parsed = parseWorkerCadenceReview(source);
  source.phases[0]!.maximumLiveStagesUs[0] = 999;
  // Assert
  expect(parsed.schema).toBe("worker-telemetry-cadence-v2");
  if (parsed.schema !== "worker-telemetry-cadence-v2") throw new Error("v2 required");
  expect(parsed.phases[0]!.maximumLiveStagesUs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  expect(parsed.phases[0]!.worstInterval).toEqual({ previousExecutionUs: 1000, previousLiveStagesUs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], gapUs: 500000 });
  expect(CADENCE_LIVE_STAGES).toEqual(["visible_state", "platform", "health_safety", "confirmed_settings", "settings_transaction_wait", "settings_nvs_read", "wifi", "publication_order_wait", "projection_complete", "retention", "serialization_queue"]);
});

test("historical v1 does not acquire synthetic stage diagnostics", () => {
  const legacy = cadenceFixture();
  const parsed = parseWorkerCadenceReview(legacy);
  expect(parsed).toEqual(legacy);
  expect(Object.hasOwn(parsed.phases[0]!, "worstInterval")).toBeFalse();
  expect(() => parseWorkerCadenceReview({ ...cadenceV2Fixture(), schema: "worker-telemetry-cadence-v1" })).toThrow();
});

test.each([0, 10, 12])("both v2 timing arrays reject length %s", length => {
  const invalid = Array.from({ length }, () => 0);
  expect(() => parseWorkerCadenceReview(changePhase({ maximumLiveStagesUs: invalid }))).toThrow();
  expect(() => parseWorkerCadenceReview(changePhase({ worstInterval: { ...cadenceV2Fixture().phases[0]!.worstInterval, previousLiveStagesUs: invalid } }))).toThrow();
});

test.each([-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "100", null])("v2 timing values reject invalid numeric input %s", invalid => {
  const values: unknown[] = Array.from({ length: 11 }, () => 0); values[5] = invalid;
  const worst = cadenceV2Fixture().phases[0]!.worstInterval;
  expect(() => parseWorkerCadenceReview(changePhase({ maximumLiveStagesUs: values }))).toThrow();
  expect(() => parseWorkerCadenceReview(changePhase({ worstInterval: { ...worst, previousLiveStagesUs: values } }))).toThrow();
  expect(() => parseWorkerCadenceReview(changePhase({ worstInterval: { ...worst, previousExecutionUs: invalid } }))).toThrow();
  expect(() => parseWorkerCadenceReview(changePhase({ worstInterval: { ...worst, gapUs: invalid } }))).toThrow();
});

test("v2 rejects missing or additional keys at every diagnostic boundary", () => {
  expect(() => parseWorkerCadenceReview({ ...cadenceV2Fixture(), raw: "private" })).toThrow();
  expect(() => parseWorkerCadenceReview(changePhase({ raw: "private" }))).toThrow();
  expect(() => parseWorkerCadenceReview(changePhase({ worstInterval: { ...cadenceV2Fixture().phases[0]!.worstInterval, raw: "private" } }))).toThrow();
  expect(() => parseWorkerCadenceReview({ ...cadenceFixture(), schema: "worker-telemetry-cadence-v2" })).toThrow();
  for (const key of ["previousExecutionUs", "previousLiveStagesUs", "gapUs"]) {
    const worst: Record<string, unknown> = { ...cadenceV2Fixture().phases[0]!.worstInterval }; delete worst[key];
    expect(() => parseWorkerCadenceReview(changePhase({ worstInterval: worst }))).toThrow();
  }
});

test("explicit failed-clock and overflow diagnostics remain inspectable without a new acceptance gate", () => {
  const phase = changePhase({ clockFailures: 1, overflow: true, passed: false,
    worstInterval: { previousExecutionUs: 1, previousLiveStagesUs: Array.from({ length: 11 }, () => 100), gapUs: 1 } });
  const result = parseWorkerCadenceReview(phase);
  expect(result.phases[0]!.clockFailures).toBe(1);
  expect(result.phases[0]!.passed).toBeFalse();
});

test("v2 retains zero-valued empty diagnostics and maximum safe integer clocks", () => {
  const zero = Array.from({ length: 11 }, () => 0);
  expect(parseWorkerCadenceReview(changePhase({ state: "empty", passed: false, maximumLiveStagesUs: zero,
    worstInterval: { previousExecutionUs: 0, previousLiveStagesUs: zero, gapUs: 0 } })).schema).toBe("worker-telemetry-cadence-v2");
  expect(parseWorkerCadenceReview(changePhase({ maximumLiveStagesUs: Array.from({ length: 11 }, () => Number.MAX_SAFE_INTEGER) })).schema).toBe("worker-telemetry-cadence-v2");
});


test("independent stage maxima are not incorrectly summed into one iteration", () => {
  const input = changePhase({ maximumLiveStagesUs: Array.from({ length: 11 }, () => 100) });
  expect(parseWorkerCadenceReview(input).schema).toBe("worker-telemetry-cadence-v2");
});

test("actual possessed controller exports v2 into the retained metadata-only page state", async () => {
  // Arrange
  const h = await serialHarness(); const expected = cadenceV2Fixture(); h.setCadenceReview(expected);
  const input = { ...h.input, [workerSerialQualificationHook]: { suppressHeartbeats: false } };
  const controller = createWebSerialWorkerController(input); await controller.requestPermission();
  const page = new WorkerCadenceAcceptance(); page.configure(true);
  try {
    // Act
    page.review(await controller.telemetryCadenceReview());
    // Assert
    expect(page.state().review).toEqual(expected);
    expect(h.counts().active).toBeFalse();
    expect(h.received.some(value => value.command === "start_lease")).toBeFalse();
  } finally { await controller.close(); }
});


test("sparse timing arrays cannot omit a required stage value", () => {
  const sparse = new Array(11);
  expect(() => parseWorkerCadenceReview(changePhase({ maximumLiveStagesUs: sparse }))).toThrow();
  expect(() => parseWorkerCadenceReview(changePhase({ worstInterval: { ...cadenceV2Fixture().phases[0]!.worstInterval, previousLiveStagesUs: sparse } }))).toThrow();
});
