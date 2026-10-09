import { expect, test } from "bun:test";
import vectors from "../conformance/bwg-worker-controller-0.4/preservation-vectors.json";
import { createWebSerialWorkerController, workerSerialQualificationHook } from "./webserial-worker-controller";
import { parseWorkerControllerStatus } from "./worker-controller";
import { WorkerPreservationBaseline, parseWorkerPreservation, type WorkerPreservation } from "./worker-preservation";
import { serialHarness } from "./worker-serial.test-support";

const baseline = { protocolVersion: "bwg-worker-controller/0.4", state: "baseline", monotonicMilliseconds: 1, restoration: { status: "not_required" } };

test.each(vectors.valid)("$name parses with its exact field set", ({ preservation }) => {
  // Arrange / Act / Assert
  expect(parseWorkerPreservation(preservation)).toEqual(preservation as never);
});

test.each(vectors.invalid)("$name is rejected", ({ preservation }) => {
  // Arrange / Act / Assert
  expect(() => parseWorkerPreservation(preservation)).toThrow();
});

test.each(vectors.valid)("status carrying $name parses on the shared status path", ({ preservation }) => {
  // Arrange / Act
  const status = parseWorkerControllerStatus({ ...baseline, preservation });
  // Assert
  expect(status.preservation).toEqual(preservation as never);
});

test("the acceptance continuity baseline compares version 1 and version 2 digests alike", () => {
  // Arrange
  const [v1, v2] = vectors.valid.map(({ preservation }) => parseWorkerPreservation(preservation));
  const continuity = new WorkerPreservationBaseline();
  // Act
  continuity.observe(v1!);
  continuity.observe(v2!);
  // Assert
  expect(continuity.maybePublicState()).toMatchObject({ settings_match: true, authorization_high_water_match: true, device_identity_match: true });
});

test("an ordinary qualification adapter admits a version 2 status and hands it to the preservation hook", async () => {
  // Arrange
  const h = await serialHarness();
  h.setPreservationField("schema", "worker-preservation-v2");
  h.setPreservationField("pool_configuration_unchanged_since_boot", false);
  const observed: WorkerPreservation[] = [];
  const input = { ...h.input, [workerSerialQualificationHook]: { suppressHeartbeats: false, observePreservation: (value: WorkerPreservation) => { observed.push(value); } } };
  const controller = createWebSerialWorkerController(input);
  try {
    // Act
    await controller.requestPermission();
    const status = await controller.status();
    // Assert
    expect("preservation" in status).toBeFalse();
    expect(observed.at(-1)).toMatchObject({ schema: "worker-preservation-v2", pool_configuration_unchanged_since_boot: false });
  } finally { await controller.close(); }
});
