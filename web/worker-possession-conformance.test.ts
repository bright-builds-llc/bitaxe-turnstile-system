import { expect, test } from "bun:test";

import fixtures from "../conformance/bwg-worker-possession-0.1/fixtures.json";
import {
  createWorkerPossessionChallenge,
  parseWorkerPossessionResponse,
  type WorkerPossessionBinding,
} from "./worker-possession";
import {
  decodeWorkerPossessionRequest,
  encodeWorkerPossessionMessage,
} from "./worker-possession-usb";

for (const fixture of fixtures.negativeCases) {
  test(`shared possession negative fixture: ${fixture.id}`, async () => {
    // Arrange
    const operation = negativeOperation(fixture.operation);

    // Act
    const result = Promise.resolve().then(operation);

    // Assert
    await expect(result).rejects.toThrow(
      fixture.expectedError === "invalid_request"
        ? "Worker possession request is invalid"
        : fixture.expectedError === "invalid_frame"
          ? "Worker possession frame is"
          : "Worker possession proof is invalid",
    );
  });
}

function negativeOperation(operation: string): () => unknown {
  if (operation === "unknown_request_field") {
    return () => decodeWorkerPossessionRequest(encodeWorkerPossessionMessage({
      ...fixtures.initialAdmission.request,
      unknown: true,
    }));
  }
  if (operation === "arbitrary_signing_request") {
    return () => decodeWorkerPossessionRequest(encodeWorkerPossessionMessage({
      profile: "bwg-worker-possession/0.1",
      requestId: "pos_arbitrary_01",
      command: "sign",
      payload: { message: "arbitrary bytes" },
    }));
  }
  if (operation === "oversized_frame") {
    return () => decodeWorkerPossessionRequest(new Uint8Array(65_537));
  }
  if (operation === "replay") {
    return async () => {
      const challenge = createWorkerPossessionChallenge(initialBinding());
      await challenge.verify(fixtures.initialAdmission.response);
      return challenge.verify(fixtures.initialAdmission.response);
    };
  }
  return () => {
    const response = parseWorkerPossessionResponse(
      structuredClone(fixtures.initialAdmission.response),
    );
    if (!response.ok) throw new Error("fixture response must be successful");
    if (operation === "changed_nonce") response.result.claims.possessionNonce = "F".repeat(43);
    if (operation === "changed_purpose") {
      response.result.claims.purpose = "transport_reacquisition";
    }
    if (operation === "changed_challenge_binding") {
      response.result.claims.challengeBindingSha256 = "F".repeat(43);
    }
    if (operation === "changed_capability_digest") {
      response.result.claims.controllerCapabilitySha256 = "F".repeat(43);
    }
    if (operation === "changed_descriptor_digest") {
      response.result.claims.applicationDescriptorSha256 = "F".repeat(43);
    }
    if (operation === "replacement_identity") {
      response.result.claims.deviceIdentityJwk.x = "G".repeat(43);
    }
    if (operation === "weak_identity_key") {
      response.result.claims.deviceIdentityJwk.x = "A".repeat(43);
    }
    return createWorkerPossessionChallenge(initialBinding()).verify(response);
  };
}

function initialBinding(): WorkerPossessionBinding {
  return {
    requestId: fixtures.initialAdmission.request.requestId,
    purpose: "initial_admission",
    possessionNonce: fixtures.initialAdmission.request.payload.possessionNonce,
    challengeBindingSha256:
      fixtures.initialAdmission.request.payload.challengeBindingSha256,
    controllerCapabilitySha256:
      fixtures.initialAdmission.request.payload.controllerCapabilitySha256,
    applicationDescriptorSha256:
      fixtures.initialAdmission.request.payload.applicationDescriptorSha256,
  };
}
