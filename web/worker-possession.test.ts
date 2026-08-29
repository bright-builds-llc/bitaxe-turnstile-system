import { describe, expect, test } from "bun:test";

import possessionFixtures from "../conformance/bwg-worker-possession-0.1/fixtures.json";
import {
  createWorkerPossessionChallenge,
  parseWorkerPossessionResponse,
  type WorkerPossessionBinding,
  type WorkerPossessionResponse,
} from "./worker-possession";

const binding = {
  requestId: "pos_initial_01",
  purpose: "initial_admission",
  possessionNonce: "B".repeat(43),
  challengeBindingSha256: "C".repeat(43),
  controllerCapabilitySha256:
    possessionFixtures.initialAdmission.request.payload.controllerCapabilitySha256,
  applicationDescriptorSha256:
    possessionFixtures.initialAdmission.request.payload.applicationDescriptorSha256,
  expectedFirmwareSourceCommit: "a".repeat(40),
} as const;

const claims = {
  profile: "bwg-worker-possession-proof/0.1",
  purpose: "initial_admission",
  possessionNonce: "B".repeat(43),
  challengeBindingSha256: "C".repeat(43),
  controllerCapabilitySha256: "D".repeat(43),
  applicationDescriptorSha256: "E".repeat(43),
  firmwareSourceCommit: "a".repeat(40),
  deviceIdentityJwk: {
    kty: "OKP",
    crv: "Ed25519",
    x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
    alg: "Ed25519",
    use: "sig",
    key_ops: ["verify"],
  },
} as const;

const response = {
  profile: "bwg-worker-possession/0.1",
  requestId: "pos_initial_01",
  ok: true,
  result: {
    claims,
    compactJws:
      "eyJhbGciOiJFZDI1NTE5IiwidHlwIjoiYndnLXdvcmtlci1wb3NzZXNzaW9uK2p3cyJ9.eyJhcHBsaWNhdGlvbkRlc2NyaXB0b3JTaGEyNTYiOiJFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFIiwiY2hhbGxlbmdlQmluZGluZ1NoYTI1NiI6IkNDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0MiLCJjb250cm9sbGVyQ2FwYWJpbGl0eVNoYTI1NiI6IkREREREREREREREREREREREREREREREREREREREREREREREREREREREREQiLCJkZXZpY2VJZGVudGl0eUp3ayI6eyJhbGciOiJFZDI1NTE5IiwiY3J2IjoiRWQyNTUxOSIsImtleV9vcHMiOlsidmVyaWZ5Il0sImt0eSI6Ik9LUCIsInVzZSI6InNpZyIsIngiOiIxMXFZQVlLeENyZlZTXzdUeVdRSE9nN2hjdlBhcGlNbHJ3SWFhUGNIVVJvIn0sInBvc3Nlc3Npb25Ob25jZSI6IkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkIiLCJwcm9maWxlIjoiYndnLXdvcmtlci1wb3NzZXNzaW9uLXByb29mLzAuMSIsInB1cnBvc2UiOiJpbml0aWFsX2FkbWlzc2lvbiJ9.HRZJQ-QwaNjKTJSsUK6b7_w9OTkpf21eH6g7IWu_swWPfC6NZe697_jaAM8Sw5LZqq4SIRUBMFR8sOg1G1FZAw",
  },
} as const satisfies WorkerPossessionResponse;

const reacquisitionResponse = {
  profile: "bwg-worker-possession/0.1",
  requestId: "pos_reacquire_01",
  ok: true,
  result: {
    claims: {
      ...claims,
      purpose: "transport_reacquisition",
      possessionNonce: "F".repeat(43),
    },
    compactJws:
      "eyJhbGciOiJFZDI1NTE5IiwidHlwIjoiYndnLXdvcmtlci1wb3NzZXNzaW9uK2p3cyJ9.eyJhcHBsaWNhdGlvbkRlc2NyaXB0b3JTaGEyNTYiOiJFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFIiwiY2hhbGxlbmdlQmluZGluZ1NoYTI1NiI6IkNDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0MiLCJjb250cm9sbGVyQ2FwYWJpbGl0eVNoYTI1NiI6IkREREREREREREREREREREREREREREREREREREREREREREREREREREREREQiLCJkZXZpY2VJZGVudGl0eUp3ayI6eyJhbGciOiJFZDI1NTE5IiwiY3J2IjoiRWQyNTUxOSIsImtleV9vcHMiOlsidmVyaWZ5Il0sImt0eSI6Ik9LUCIsInVzZSI6InNpZyIsIngiOiIxMXFZQVlLeENyZlZTXzdUeVdRSE9nN2hjdlBhcGlNbHJ3SWFhUGNIVVJvIn0sInBvc3Nlc3Npb25Ob25jZSI6IkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkYiLCJwcm9maWxlIjoiYndnLXdvcmtlci1wb3NzZXNzaW9uLXByb29mLzAuMSIsInB1cnBvc2UiOiJ0cmFuc3BvcnRfcmVhY3F1aXNpdGlvbiJ9.6Ad2kqHY4m3I5kIVs1YsEgS4gjD6bQKOQH0sLJMdz-kIahMuLrcmkQ1Td2KTCP3FxTLvqsj6jL58bTBCQiQgCA",
  },
} as const satisfies WorkerPossessionResponse;

describe("Local Device Possession Proof", () => {
  test("derives a Device Identity-bound authorization context from the verified transcript", async () => {
    // Arrange
    const request = possessionFixtures.initialAdmission.request;
    const challenge = createWorkerPossessionChallenge({
      requestId: request.requestId,
      ...request.payload,
      purpose: "initial_admission",
    });

    // Act
    const verified = await challenge.verify(possessionFixtures.initialAdmission.response);

    // Assert
    expect(verified.controlSessionBindingSha256).toBe(
      "OVu7haWZbSztlTWc6djBGk10R1FzkHL9Wnf4M2sQtI0",
    );
  });

  test("establishes one Device Identity fingerprint from a fresh bound proof", async () => {
    // Arrange
    const challenge = createWorkerPossessionChallenge(binding);

    // Act
    const verified = await challenge.verify(possessionFixtures.initialAdmission.response);

    // Assert
    expect(challenge.request).toEqual({
      profile: "bwg-worker-possession/0.1",
      requestId: "pos_initial_01",
      command: "prove_possession",
      payload: {
        purpose: "initial_admission",
        possessionNonce: "B".repeat(43),
        challengeBindingSha256: "C".repeat(43),
        controllerCapabilitySha256:
          possessionFixtures.initialAdmission.request.payload.controllerCapabilitySha256,
        applicationDescriptorSha256:
          possessionFixtures.initialAdmission.request.payload.applicationDescriptorSha256,
      },
    });
    expect(verified.deviceIdentityFingerprint).toBe(
      "hY0InB-Rsm_aD1yTwooBeb9rZ70sRetubQskIJmm490",
    );
    expect(verified.firmwareSourceCommit).toBe("a".repeat(40));
  });

  test("rejects a valid Device Identity proof from a different firmware source", async () => {
    // Arrange
    const challenge = createWorkerPossessionChallenge({
      ...binding,
      expectedFirmwareSourceCommit: "b".repeat(40),
    });

    // Act
    const verification = challenge.verify(possessionFixtures.initialAdmission.response);

    // Assert
    await expect(verification).rejects.toThrow("Worker possession proof is invalid");
  });

  test("rejects legacy signatures that did not sign the firmware source claim", async () => {
    // Arrange
    const initial = createWorkerPossessionChallenge(binding);
    const reacquisition = createWorkerPossessionChallenge({
      ...binding,
      requestId: "pos_reacquire_01",
      purpose: "transport_reacquisition",
      possessionNonce: "F".repeat(43),
      expectedDeviceIdentityFingerprint:
        "hY0InB-Rsm_aD1yTwooBeb9rZ70sRetubQskIJmm490",
    });

    // Act / Assert
    await expect(initial.verify(response)).rejects.toThrow(
      "Worker possession proof is invalid",
    );
    await expect(reacquisition.verify(reacquisitionResponse)).rejects.toThrow(
      "Worker possession proof is invalid",
    );
  });

  test("reacquires only the previously established Device Identity", async () => {
    // Arrange
    const challenge = createWorkerPossessionChallenge({
      ...binding,
      requestId: "pos_reacquire_01",
      purpose: "transport_reacquisition",
      possessionNonce: "F".repeat(43),
      expectedDeviceIdentityFingerprint:
        "hY0InB-Rsm_aD1yTwooBeb9rZ70sRetubQskIJmm490",
    });

    // Act
    const verified = await challenge.verify(possessionFixtures.reacquisition.response);

    // Assert
    expect(verified.deviceIdentityFingerprint).toBe(
      "hY0InB-Rsm_aD1yTwooBeb9rZ70sRetubQskIJmm490",
    );
  });

  test("consumes a possession challenge before asynchronous verification", async () => {
    // Arrange
    const challenge = createWorkerPossessionChallenge(binding);

    // Act
    const first = challenge.verify(possessionFixtures.initialAdmission.response);
    const replay = expect(
      challenge.verify(possessionFixtures.initialAdmission.response),
    ).rejects.toThrow(
      "Worker possession proof is invalid",
    );

    // Assert
    await expect(first).resolves.toMatchObject({
      deviceIdentityFingerprint: "hY0InB-Rsm_aD1yTwooBeb9rZ70sRetubQskIJmm490",
    });
    await replay;
  });

  test("rejects a proof whose fresh nonce binding changed", async () => {
    // Arrange
    const challenge = createWorkerPossessionChallenge(binding);
    const changed: WorkerPossessionResponse = parseWorkerPossessionResponse(
      structuredClone(possessionFixtures.initialAdmission.response),
    );
    if (!changed.ok) throw new Error("test possession response must be successful");
    changed.result.claims.possessionNonce = "F".repeat(43);

    // Act
    const verification = challenge.verify(changed);

    // Assert
    await expect(verification).rejects.toThrow("Worker possession proof is invalid");
  });

  test("rejects a replacement Device Identity during reacquisition", async () => {
    // Arrange
    const challenge = createWorkerPossessionChallenge({
      ...binding,
      requestId: "pos_reacquire_01",
      purpose: "transport_reacquisition",
      possessionNonce: "F".repeat(43),
      expectedDeviceIdentityFingerprint: "G".repeat(43),
    });

    // Act
    const verification = challenge.verify(possessionFixtures.reacquisition.response);

    // Assert
    await expect(verification).rejects.toThrow("Worker possession proof is invalid");
  });

  test("rejects reacquisition without the previously established fingerprint", () => {
    // Arrange
    const missingFingerprint = {
      ...binding,
      requestId: "pos_reacquire_01",
      purpose: "transport_reacquisition",
      possessionNonce: "F".repeat(43),
    };

    // Act
    const construction = () => createWorkerPossessionChallenge(
      missingFingerprint as unknown as WorkerPossessionBinding,
    );

    // Assert
    expect(construction).toThrow("Worker possession request is invalid");
  });
});
