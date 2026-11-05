import { expect, test } from "bun:test";

import vectors from "../conformance/bwg-worker-deployment-trust-0.2/authority-signer-vectors.json";
import {
  parseWorkLeaseAuthorityTrust,
  verifyWorkerLeaseAuthorization,
  type WorkerLeaseAuthorizationInput,
} from "../web/worker-lease-authorization";
import { buildWorkLeaseAuthorityVectors } from "./work-lease-authority-vectors";

test("committed Authority signer vectors match a fresh TypeScript signature", async () => {
  // Act
  const rebuilt = await buildWorkLeaseAuthorityVectors();

  // Assert
  expect(rebuilt).toEqual(vectors);
});

test("the TypeScript verifier accepts every Authority signer vector", async () => {
  // Arrange
  const trust = parseWorkLeaseAuthorityTrust(vectors.trust);

  // Act
  const verified = await Promise.all(
    vectors.cases.map((vector) =>
      verifyWorkerLeaseAuthorization(
        vector.authorization,
        vector.input as WorkerLeaseAuthorizationInput,
        trust,
      ),
    ),
  );

  // Assert
  expect(verified.map((result) => result.sequence.toString())).toEqual(
    vectors.cases.map((vector) => vector.sequence),
  );
});
