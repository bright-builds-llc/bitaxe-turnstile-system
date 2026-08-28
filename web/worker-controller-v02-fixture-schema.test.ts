import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";

import controllerSchema from "../conformance/bwg-worker-controller-0.2/contract.schema.json";
import controllerFixtures from "../conformance/bwg-worker-controller-0.2/fixtures.json";
import transportSchema from "../conformance/bwg-worker-usb-0.1/contract.schema.json";
import transportFixtures from "../conformance/bwg-worker-usb-0.1/fixtures.json";
import {
  parseWorkerControllerCapabilitiesV02,
  parseWorkerControllerStatusV02,
  parseWorkerLeaseGrantV02,
  parseWorkerLeaseRenewalV02,
  verifyWorkerControllerCapabilityV02,
} from "./worker-controller-v02";
import { parseWorkerUsbTransportProfile } from "./worker-usb-profile";

test("published Controller 0.2 fixtures satisfy schema and runtime parsers", () => {
  // Arrange
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(controllerSchema);

  // Act
  const schemaValid = validate(controllerFixtures);
  const capability = parseWorkerControllerCapabilitiesV02(controllerFixtures.capabilities);
  const grant = parseWorkerLeaseGrantV02(controllerFixtures.lease);
  const renewal = parseWorkerLeaseRenewalV02(controllerFixtures.renewal);
  const status = parseWorkerControllerStatusV02(controllerFixtures.status);

  // Assert
  expect(validate.errors).toBeNull();
  expect(schemaValid).toBe(true);
  expect(String(capability.protocolVersion)).toBe(controllerFixtures.profile);
  expect(grant.renewAfterMilliseconds).toBeLessThan(grant.durationMilliseconds);
  expect(renewal.renewAfterMilliseconds).toBeLessThan(renewal.durationMilliseconds);
  expect(status.state).toBe("baseline");
});

test("published Worker USB fixtures satisfy schema and the separated topology parser", () => {
  // Arrange
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(transportSchema);

  // Act
  const schemaValid = validate(transportFixtures);
  const profile = parseWorkerUsbTransportProfile(transportFixtures.topology);

  // Assert
  expect(validate.errors).toBeNull();
  expect(schemaValid).toBe(true);
  expect(String(profile.profile)).toBe(transportFixtures.profile);
  expect(profile.application.functions.map((item) => item.role)).toEqual([
    "worker_control",
    "worker_evidence",
  ]);
});

test("published capability signature binds the exact Worker USB application descriptor", async () => {
  // Arrange
  const capability = parseWorkerControllerCapabilitiesV02(controllerFixtures.capabilities);
  const descriptor = parseWorkerUsbTransportProfile(transportFixtures.topology).application
    .descriptor;

  // Act
  const verified = await verifyWorkerControllerCapabilityV02(
    capability,
    descriptor,
    controllerFixtures.updateAuthorityKeys,
  );

  // Assert
  expect(verified).toEqual(capability);
});

test("Controller 0.2 schema rejects contradictory baseline restoration state", () => {
  // Arrange
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(controllerSchema);
  const contradictory = structuredClone(controllerFixtures);
  contradictory.status = {
    protocolVersion: "bwg-worker-controller/0.2",
    state: "baseline",
    monotonicMilliseconds: 0,
    restoration: { status: "pending" },
  };

  // Act
  const valid = validate(contradictory);

  // Assert
  expect(valid).toBe(false);
});
