import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";

import schema from "../conformance/bwg-worker-controller-0.4/contract.schema.json";
import fixtures from "../conformance/bwg-worker-controller-0.4/fixtures.json";
import {
  parseWorkerControllerCapabilities,
  parseWorkerLeaseGrant,
  parseWorkerLeaseRenewal,
} from "./worker-controller";

test("published Worker Controller fixtures satisfy schema and runtime parsers", () => {
  // Arrange
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

  // Act
  const schemaValid = validate(fixtures);
  const capabilities = parseWorkerControllerCapabilities(fixtures.capabilities);
  const lease = parseWorkerLeaseGrant(fixtures.lease);
  const renewal = parseWorkerLeaseRenewal(fixtures.renewal);

  // Assert
  expect(validate.errors).toBeNull();
  expect(schemaValid).toBe(true);
  expect(String(capabilities.protocolVersion)).toBe(fixtures.profile);
  expect(lease.renewAfterMilliseconds).toBeLessThan(lease.durationMilliseconds);
  expect(renewal.renewAfterMilliseconds).toBeLessThan(renewal.durationMilliseconds);
});
