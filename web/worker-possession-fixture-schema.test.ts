import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import schema from "../conformance/bwg-worker-possession-0.2/contract.schema.json";
import fixtures from "../conformance/bwg-worker-possession-0.2/fixtures.json";

test("published possession fixture has the exact closed serial-session schema", () => {
  // Arrange
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(
    schema,
  );
  // Act
  const valid = validate(fixtures);
  // Assert
  expect(validate.errors).toBeNull();
  expect(valid).toBeTrue();
});
