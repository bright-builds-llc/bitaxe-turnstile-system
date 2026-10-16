import { expect, test } from "bun:test";
import vectors from "../conformance/bwg-worker-controller-0.4/soak-allowance-vectors.json";
import { parseWorkerLeaseGrant } from "./worker-controller";
import { parseWorkLeaseAuthorityTrust, signWorkerLeaseAuthorization, verifyWorkerLeaseAuthorization } from "./worker-lease-authorization";

for (const vector of vectors.vectors) test(`the signed v2 soak vector with ordinal ${vector.grant.soakAllowance.ordinal} verifies`, async () => {
  // Arrange
  const trust = parseWorkLeaseAuthorityTrust(vectors.trust);
  const { authorization, ...request } = parseWorkerLeaseGrant(vector.grant);
  const input = { operation: "start" as const, activeChallengeId: request.challengeId, controlSessionBindingSha256: vector.input.controlSessionBindingSha256, request };
  // Act / Assert
  await expect(verifyWorkerLeaseAuthorization(authorization, input, trust)).resolves.toMatchObject({ sequence: BigInt(request.soakAllowance!.ordinal) });
});

test("no soak vector carries a hardware profile", () => {
  // Arrange / Act
  const text = JSON.stringify(vectors);
  // Assert
  expect(text.includes("hardwareProfile")).toBeFalse();
});

test("every soak vector is a v2 allowance at 600,000 ms", () => {
  // Arrange / Act
  const allowances = vectors.vectors.map(vector => [vector.grant.soakAllowance.schema, vector.grant.soakAllowance.maximumActiveMilliseconds]);
  // Assert
  expect(allowances).toEqual(vectors.vectors.map(() => ["worker-soak-allowance-v2", 600000]));
});

test("the signer refuses a grant that carries a hardware profile", async () => {
  // Arrange
  const privateKey = (await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"])).privateKey;
  const vector = vectors.vectors[0]!;
  const input = { ...vector.input, request: { ...vector.input.request, hardwareProfile: "conservative" } };
  // Act
  const signing = signWorkerLeaseAuthorization({ input: input as never, sequence: "1", kid: "rfc8032", issuer: vectors.trust.issuer, audience: vectors.trust.audience, privateKey });
  // Assert
  await expect(signing).rejects.toThrow();
});
