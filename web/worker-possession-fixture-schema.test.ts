import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";

import schema from "../conformance/bwg-worker-possession-0.1/contract.schema.json";
import fixtures from "../conformance/bwg-worker-possession-0.1/fixtures.json";
import controllerFixtures from "../conformance/bwg-worker-controller-0.3/fixtures.json";
import usbFixtures from "../conformance/bwg-worker-usb-0.2/fixtures.json";
import { sha256Base64UrlBytes } from "./crypto-bytes";
import { canonicalJson } from "./headless-values";
import {
  createWorkerPossessionChallenge,
  type InitialWorkerPossessionBinding,
  type WorkerPossessionBinding,
} from "./worker-possession";
import { parseWorkerUsbTransportProfileV02 } from "./worker-usb-v02-profile";

test("published possession fixtures satisfy schema and runtime verification", async () => {
  // Arrange
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const initialBinding = initialBindingFrom(fixtures.initialAdmission.request);
  const reacquisitionRequest = fixtures.reacquisition.request;
  const reacquisitionBinding = {
    requestId: reacquisitionRequest.requestId,
    purpose: "transport_reacquisition",
    possessionNonce: reacquisitionRequest.payload.possessionNonce,
    challengeBindingSha256: reacquisitionRequest.payload.challengeBindingSha256,
    controllerCapabilitySha256:
      reacquisitionRequest.payload.controllerCapabilitySha256,
    applicationDescriptorSha256:
      reacquisitionRequest.payload.applicationDescriptorSha256,
    expectedDeviceIdentityFingerprint: fixtures.fixtureIdentity.fingerprintSha256,
  } as const satisfies WorkerPossessionBinding;
  const descriptor = parseWorkerUsbTransportProfileV02(usbFixtures.topology).application
    .descriptor;

  // Act
  const schemaValid = validate(fixtures);
  const initial = await createWorkerPossessionChallenge(initialBinding).verify(
    fixtures.initialAdmission.response,
  );
  const reacquired = await createWorkerPossessionChallenge(reacquisitionBinding).verify(
    fixtures.reacquisition.response,
  );
  const capabilityDigest = await digest(controllerFixtures.capabilities);
  const descriptorDigest = await digest(descriptor);
  const weakKeyForgery = expect(
    createWorkerPossessionChallenge(initialBinding).verify(fixtures.weakKeyForgery),
  ).rejects.toThrow(
    "Worker possession proof is invalid",
  );
  const nonCanonicalWeakKeyForgery = expect(
    createWorkerPossessionChallenge(initialBinding).verify(
      fixtures.nonCanonicalWeakKeyForgery,
    ),
  ).rejects.toThrow(
    "Worker possession proof is invalid",
  );
  const invalidSignWeakKeyForgery = expect(
    createWorkerPossessionChallenge(initialBinding).verify(
      fixtures.invalidSignWeakKeyForgery,
    ),
  ).rejects.toThrow("Worker possession proof is invalid");

  // Assert
  expect(validate.errors).toEqual(null);
  expect(schemaValid).toBe(true);
  expect(initial.deviceIdentityFingerprint).toBe(fixtures.fixtureIdentity.fingerprintSha256);
  expect(reacquired).toEqual(initial);
  expect(fixtures.initialAdmission.request.payload.controllerCapabilitySha256).toBe(
    capabilityDigest,
  );
  expect(fixtures.initialAdmission.request.payload.applicationDescriptorSha256).toBe(
    descriptorDigest,
  );
  await weakKeyForgery;
  await nonCanonicalWeakKeyForgery;
  await invalidSignWeakKeyForgery;
});

async function digest(value: unknown): Promise<string> {
  return sha256Base64UrlBytes(new TextEncoder().encode(canonicalJson(value)));
}

function initialBindingFrom(
  request: typeof fixtures.initialAdmission.request,
): InitialWorkerPossessionBinding {
  const purpose = request.payload.purpose;
  if (purpose !== "initial_admission") {
    throw new Error("fixture possession purpose is invalid");
  }
  return { requestId: request.requestId, ...request.payload, purpose };
}
