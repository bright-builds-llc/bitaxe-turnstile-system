import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import fixture from "../conformance/bwg-worker-serial-0.2/fixtures.json";
import schema from "../conformance/bwg-worker-serial-0.2/contract.schema.json";
import {
  WorkerSerialFramer,
  encodeWorkerSerialEnvelope,
  parseWorkerSerialEnvelope,
} from "./worker-serial";
test("published serial frames satisfy strict schema and production stream parsing", async () => {
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
      await new WorkerSerialFramer().push(await encodeWorkerSerialEnvelope(frame)),
    ).toEqual([frame]);
    expect(await new WorkerSerialFramer().push(new TextEncoder().encode(vector.wire))).toEqual([frame]);
  }
});
