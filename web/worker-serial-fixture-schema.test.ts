import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import fixture from "../conformance/bwg-worker-serial-0.1/fixtures.json";
import schema from "../conformance/bwg-worker-serial-0.1/contract.schema.json";
import {
  WorkerSerialFramer,
  encodeWorkerSerialEnvelope,
  parseWorkerSerialEnvelope,
} from "./worker-serial";
test("published serial frames satisfy strict schema and production stream parsing", () => {
  // Arrange
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(
    schema,
  );
  // Act / Assert
  expect(validate(fixture)).toBeTrue();
  expect(validate.errors).toBeNull();
  for (const vector of fixture.frames) {
    const frame = parseWorkerSerialEnvelope(vector.frame);
    expect(
      new WorkerSerialFramer().push(encodeWorkerSerialEnvelope(frame)),
    ).toEqual([frame]);
  }
});
