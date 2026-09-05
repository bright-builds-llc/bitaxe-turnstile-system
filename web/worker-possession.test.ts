import { expect, test } from "bun:test";
import fixtures from "../conformance/bwg-worker-possession-0.2/fixtures.json";
import {
  createWorkerPossessionChallenge,
  parseWorkerPossessionRequest,
} from "./worker-possession";

function initial() {
  const request = fixtures.initialAdmission.request;
  return createWorkerPossessionChallenge({
    ...request.payload,
    purpose: "initial_admission",
    requestId: request.requestId,
  });
}
test("fresh signed serial possession binds the exact identity, package and authorization session", async () => {
  // Arrange
  const challenge = initial();
  // Act
  const result = await challenge.verify(fixtures.initialAdmission.response);
  // Assert
  expect(result.deviceIdentityFingerprint).toBe(
    fixtures.fixtureIdentity.fingerprintSha256,
  );
  expect(result.controlSessionBindingSha256).toBe(
    fixtures.controlSessionBindingSha256,
  );
  expect(result.firmwareSourceCommit).toBe("a".repeat(40));
  expect(result.appElfSha256).toBe("b".repeat(64));
  await expect(
    challenge.verify(fixtures.initialAdmission.response),
  ).rejects.toThrow();
});
test("fresh reacquisition requires the previously established Device Identity", async () => {
  // Arrange
  const request = fixtures.reacquisition.request;
  const binding = {
    ...request.payload,
    purpose: "transport_reacquisition" as const,
    requestId: request.requestId,
    expectedDeviceIdentityFingerprint:
      fixtures.fixtureIdentity.fingerprintSha256,
  };
  // Act / Assert
  await expect(
    createWorkerPossessionChallenge(binding).verify(
      fixtures.reacquisition.response,
    ),
  ).resolves.toMatchObject({
    deviceIdentityFingerprint: binding.expectedDeviceIdentityFingerprint,
  });
  await expect(
    createWorkerPossessionChallenge({
      ...binding,
      expectedDeviceIdentityFingerprint: "A".repeat(43),
    }).verify(fixtures.reacquisition.response),
  ).rejects.toThrow();
});
test("every current serial-session and package binding is signed", async () => {
  // Arrange
  for (const field of [
    "sessionId",
    "hostNonce",
    "deviceNonce",
    "serialManifestSha256",
    "controllerCapabilitySha256",
    "challengeBindingSha256",
    "possessionNonce",
    "firmwareSourceCommit",
    "appElfSha256",
  ]) {
    const response = structuredClone(fixtures.initialAdmission.response);
    const claims = response.result.claims as Record<string, unknown>;
    claims[field] =
      field === "sessionId"
        ? "AAAAAAAAAAAAAAAAAAAAAA"
        : field === "firmwareSourceCommit"
          ? "c".repeat(40)
          : field === "appElfSha256"
            ? "c".repeat(64)
            : "A".repeat(43);
    // Act / Assert
    await expect(initial().verify(response)).rejects.toThrow();
  }
});
test("weak identity points, wrong package expectations and arbitrary signing fields fail closed", async () => {
  // Arrange / Act / Assert
  for (const response of [
    fixtures.weakKeyForgery,
    fixtures.nonCanonicalWeakKeyForgery,
    fixtures.invalidSignWeakKeyForgery,
  ])
    await expect(initial().verify(response)).rejects.toThrow();
  const request = fixtures.initialAdmission.request;
  await expect(
    createWorkerPossessionChallenge({
      ...request.payload,
      purpose: "initial_admission",
      requestId: request.requestId,
      expectedAppElfSha256: "c".repeat(64),
    }).verify(fixtures.initialAdmission.response),
  ).rejects.toThrow();
  expect(() =>
    parseWorkerPossessionRequest({ ...request, arbitrary: "sign-me" }),
  ).toThrow();
  expect(() =>
    parseWorkerPossessionRequest({
      ...request,
      payload: {
        ...request.payload,
        applicationDescriptorSha256: "A".repeat(43),
      },
    }),
  ).toThrow();
});
