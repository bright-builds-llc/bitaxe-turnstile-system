import { expect, test } from "bun:test";
import { cadenceFixture } from "./worker-telemetry-cadence.fixture";
import { parseWorkerCadenceArm, parseWorkerCadenceReview, parseWorkerTelemetryEndpoint } from "./worker-telemetry-cadence";
import { serialHarness } from "./worker-serial.test-support";
import { createWebSerialWorkerController, workerSerialQualificationHook } from "./webserial-worker-controller";

const endpoint = { schema: "worker-telemetry-endpoint-v1", ipv4: "192.0.2.10", httpPort: 80, observedAtUs: 123, bootOrdinal: 1, generation: 7 };
test("cadence export keeps phase order and complete numeric summaries", () => {
  const source = cadenceFixture();
  const result = parseWorkerCadenceReview(source);
  expect(result).toEqual(source);
  source.phases[0]!.intervalCount = 99;
  expect(result.phases[0]!.intervalCount).toBe(120);
});
test.each([
  { phases: [] }, { droppedObservations: -1 }, { snapshotAvailable: "true" }, { endpoint: "private" },
  { phases: [cadenceFixture().phases[1], cadenceFixture().phases[0], cadenceFixture().phases[2]] },
])("invalid cadence export cannot smuggle metadata", change => {
  expect(() => parseWorkerCadenceReview({ ...cadenceFixture(), ...change })).toThrow();
});
test.each([
  { raw: "private" }, { maximumLiveUs: Infinity }, { generation: 2 ** 32 }, { state: "finished" },
  { intervalBuckets: [0, 119, 0, 0] }, { intervalBuckets: [120] }, { pendingSends: -1 }, { overflow: true },
])("invalid phase observations remain failures", change => {
  const input = cadenceFixture();
  const invalid = { ...input, phases: [{ ...input.phases[0]!, ...change }, ...input.phases.slice(1)] };
  expect(() => parseWorkerCadenceReview(invalid)).toThrow();
});
test("arm receipt admits only explicit fixed phases", () => {
  const arm = { schema: "worker-telemetry-cadence-arm-v1", phase: "mining", generation: 7, armedAtUs: 1 };
  expect(parseWorkerCadenceArm(arm).phase).toBe("mining");
  for (const change of [{ phase: "custom" }, { armedAtUs: -1 }, { raw: "private" }]) expect(() => parseWorkerCadenceArm({ ...arm, ...change })).toThrow();
});
test.each([
  { ipv4: "http://192.0.2.10" }, { ipv4: "127.0.0.1" }, { ipv4: "192.0.2.256" }, { ipv4: "192.000.2.10" },
  { ipv4: "224.0.0.1" }, { httpPort: 0 }, { httpPort: 65536 }, { observedAtUs: -1 }, { ssid: "private" },
])("private endpoint parser rejects malformed addresses and extra identity data", change => {
  expect(() => parseWorkerTelemetryEndpoint({ ...endpoint, ...change })).toThrow();
});
test("actual controller refreshes possession and keeps endpoint out of callbacks and traces", async () => {
  // Arrange
  const h = await serialHarness(); const publicValues: unknown[] = [];
  Object.assign(h.input, { [workerSerialQualificationHook]: { suppressHeartbeats: false,
    observeStatus: (value: unknown) => publicValues.push(value), maybeObserveDiagnostic: (value: unknown) => publicValues.push(value) } });
  const controller = createWebSerialWorkerController(h.input);
  await controller.requestPermission();
  try {
    const before = h.received.length;
    // Act
    const observed = await controller.telemetryCadenceEndpoint();
    const arm = await controller.telemetryCadenceArm("idle");
    const review = await controller.telemetryCadenceReview();
    // Assert
    expect(observed.ipv4).toBe(endpoint.ipv4);
    expect(observed.controlSessionBindingSha256).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(arm.phase).toBe("idle"); expect(review.phases).toHaveLength(3);
    const requests = h.received.slice(before);
    expect(requests.filter(value => value.command === "prove_possession").length).toBe(3);
    const published = JSON.stringify({ publicValues, trace: controller.exportBrowserSerialTrace() });
    expect(published).not.toContain(endpoint.ipv4);
    expect(published).not.toContain(observed.controlSessionBindingSha256);
    expect(h.counts().active).toBeFalse();
  } finally { await controller.close(); }
});
test("ordinary controller rejects cadence before emitting requests", async () => {
  const h = await serialHarness(); await h.controller.requestPermission();
  try {
    const before = h.received.length;
    await expect(h.controller.telemetryCadenceArm("idle")).rejects.toThrow();
    await expect(h.controller.telemetryCadenceReview()).rejects.toThrow();
    await expect(h.controller.telemetryCadenceEndpoint()).rejects.toThrow();
    expect(h.received.length).toBe(before);
  } finally { await h.controller.close(); }
});
test("active lease rejects cadence review, arm and endpoint before wire operations", async () => {
  const h = await serialHarness();
  Object.assign(h.input, { [workerSerialQualificationHook]: { suppressHeartbeats: false } });
  const controller = createWebSerialWorkerController(h.input); await controller.requestPermission();
  try {
    const grant = await h.grant(await controller.prepareWorkerLeaseAuthorizationContext("start"));
    await controller.startLease(grant); const before = h.received.length;
    await expect(controller.telemetryCadenceArm("mining")).rejects.toThrow();
    await expect(controller.telemetryCadenceReview()).rejects.toThrow();
    await expect(controller.telemetryCadenceEndpoint()).rejects.toThrow();
    expect(h.received.length).toBe(before);
  } finally { await controller.close(); }
});

test("private endpoint handoff reuses only the exact recently reviewed proof", async () => {
  // Arrange
  const h = await serialHarness();
  Object.assign(h.input, { [workerSerialQualificationHook]: { suppressHeartbeats: false } });
  const controller = createWebSerialWorkerController(h.input); await controller.requestPermission();
  try {
    const reviewed = await controller.prepareWorkerLeaseAuthorizationContext("start");
    await controller.qualificationAttemptReview(); const before = h.received.length;
    // Act
    const observed = await controller.telemetryCadenceEndpoint(reviewed.controlSessionBindingSha256);
    // Assert
    expect(observed.controlSessionBindingSha256).toBe(reviewed.controlSessionBindingSha256);
    expect(h.received.slice(before).map(value => value.command)).toEqual(["telemetry_cadence_endpoint"]);
    await expect(controller.telemetryCadenceEndpoint("wrong-proof")).rejects.toThrow();
    await h.advance(5001);
    await expect(controller.telemetryCadenceEndpoint(reviewed.controlSessionBindingSha256)).rejects.toThrow();
  } finally { await controller.close(); }
});

test("device maximum-probe witnesses are required independently of browser receipts", () => {
  for (const field of ["maxProbeCount", "firstMaxProbeAtUs", "lastMaxProbeAtUs"]) {
    const valid = cadenceFixture(); const phase: Record<string, unknown> = { ...valid.phases[1] };
    delete phase[field];
    expect(() => parseWorkerCadenceReview({ ...valid, phases: [valid.phases[0], phase, valid.phases[2]] })).toThrow();
  }
});
