import { expect, test } from "bun:test";

import fixtures from "../conformance/bwg-worker-deployment-trust-0.1/fixtures.json";
import { parseWorkerDeploymentTrust } from "./worker-deployment-trust";
import {
  signWorkerLeaseAuthorization,
  verifyWorkerLeaseAuthorization,
  type WorkLeaseAuthorityTrust,
  type WorkerLeaseAuthorizationInput,
} from "./worker-lease-authorization";

test("verifies one fully bound possession-context Start authorization", async () => {
  // Arrange
  const keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const trust: WorkLeaseAuthorityTrust = {
    profile: "bwg-worker-deployment-trust/0.1",
    issuer: "development-worker-lease-authority",
    audience: "bwg-worker-controller/0.3",
    role: "work_lease_authority",
    keys: [{
      kid: "dev-lease-authority-01",
      kty: "OKP",
      crv: "Ed25519",
      x: requiredJwkX(publicJwk),
      alg: "Ed25519",
      use: "sig",
      key_ops: ["verify"],
    }],
  };
  const input: WorkerLeaseAuthorizationInput = {
    operation: "start",
    activeChallengeId: "challenge_00000000000000000000000000000001",
    controlSessionBindingSha256: "S".repeat(43),
    request: {
      protocolVersion: "bwg-worker-controller/0.3",
      leaseId: "lease_fixture_03",
      challengeId: "challenge_00000000000000000000000000000001",
      durationMilliseconds: 60_000,
      renewAfterMilliseconds: 20_000,
      stratum: {
        endpoint: "stratum+tcp://127.0.0.1:3333/",
        username: "fixture-session-user",
        password: "fixture-session-password",
      },
    },
  };
  const authorization = await signWorkerLeaseAuthorization({
    input,
    sequence: "1",
    kid: "dev-lease-authority-01",
    issuer: trust.issuer,
    audience: trust.audience,
    privateKey: keyPair.privateKey,
  });

  // Act
  const verified = await verifyWorkerLeaseAuthorization(authorization, input, trust);

  // Assert
  expect(verified).toEqual({
    keyId: "dev-lease-authority-01",
    sequence: 1n,
  });
  expect(authorization).not.toContain("fixture-session");
});

function requiredJwkX(jwk: JsonWebKey): string {
  if (!jwk.x) throw new Error("fixture public key is missing x");
  return jwk.x;
}

test("fits the maximum strict authorization inside Controller 0.3", async () => {
  // Arrange
  const keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const kid = "K".repeat(32);
  const input: WorkerLeaseAuthorizationInput = {
    operation: "renew",
    activeChallengeId: "challenge_00000000000000000000000000000001",
    controlSessionBindingSha256: "S".repeat(43),
    request: {
      protocolVersion: "bwg-worker-controller/0.3",
      leaseId: "lease_fixture_03",
      durationMilliseconds: 60_000,
      renewAfterMilliseconds: 20_000,
    },
  };

  // Act
  const authorization = await signWorkerLeaseAuthorization({
    input,
    sequence: "18446744073709551615",
    kid,
    issuer: "development-worker-lease-authority",
    audience: "bwg-worker-controller/0.3",
    privateKey: keyPair.privateKey,
  });

  // Assert
  expect(new TextEncoder().encode(authorization).byteLength).toBe(481);
  await expect(signWorkerLeaseAuthorization({
    input,
    sequence: "18446744073709551616",
    kid,
    issuer: "development-worker-lease-authority",
    audience: "bwg-worker-controller/0.3",
    privateKey: keyPair.privateKey,
  })).rejects.toThrow("Worker Lease authorization is invalid");
});

test("rejects changed request and possession-context bindings", async () => {
  // Arrange
  const keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const kid = "dev-lease-authority-01";
  const trust: WorkLeaseAuthorityTrust = {
    profile: "bwg-worker-deployment-trust/0.1",
    issuer: "development-worker-lease-authority",
    audience: "bwg-worker-controller/0.3",
    role: "work_lease_authority",
    keys: [{
      kid,
      kty: "OKP",
      crv: "Ed25519",
      x: requiredJwkX(publicJwk),
      alg: "Ed25519",
      use: "sig",
      key_ops: ["verify"],
    }],
  };
  const input: WorkerLeaseAuthorizationInput = {
    operation: "start",
    activeChallengeId: "challenge_00000000000000000000000000000001",
    controlSessionBindingSha256: "S".repeat(43),
    request: {
      protocolVersion: "bwg-worker-controller/0.3",
      leaseId: "lease_fixture_03",
      challengeId: "challenge_00000000000000000000000000000001",
      durationMilliseconds: 60_000,
      renewAfterMilliseconds: 20_000,
      stratum: {
        endpoint: "stratum+tcp://127.0.0.1:3333/",
        username: "fixture-session-user",
        password: "fixture-session-password",
      },
    },
  };
  const authorization = await signWorkerLeaseAuthorization({
    input,
    sequence: "1",
    kid,
    issuer: trust.issuer,
    audience: trust.audience,
    privateKey: keyPair.privateKey,
  });

  // Act
  const changedRequest = verifyWorkerLeaseAuthorization(authorization, {
    ...input,
    request: {
      ...input.request,
      stratum: { ...input.request.stratum, password: "changed-password" },
    },
  }, trust);
  const changedContext = verifyWorkerLeaseAuthorization(authorization, {
    ...input,
    controlSessionBindingSha256: "T".repeat(43),
  }, trust);
  const results = await Promise.allSettled([changedRequest, changedContext]);

  // Assert
  expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
  expect(results.map((result) =>
    result.status === "rejected" ? String(result.reason) : "fulfilled"
  )).toEqual([
    "Error: Worker Lease authorization is invalid",
    "Error: Worker Lease authorization is invalid",
  ]);
});

test("rejects a noncanonical signature segment that decodes to valid bytes", async () => {
  // Arrange
  const trust = parseWorkerDeploymentTrust(fixtures.trust);
  const parts = fixtures.start.artifact.authorization.split(".");
  const signature = parts[2];
  if (!parts[0] || !parts[1] || !signature) throw new Error("fixture JWS invalid");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const finalIndex = alphabet.indexOf(signature.at(-1) ?? "");
  if (finalIndex < 0 || (finalIndex & 15) !== 0) {
    throw new Error("fixture signature must be canonical");
  }
  const noncanonical = `${parts[0]}.${parts[1]}.${signature.slice(0, -1)}${
    alphabet[finalIndex | 1]
  }`;

  // Act
  const result = verifyWorkerLeaseAuthorization(
    noncanonical,
    fixtures.start.input as WorkerLeaseAuthorizationInput,
    trust.workLeaseAuthority,
  );

  // Assert
  await expect(result).rejects.toThrow("Worker Lease authorization is invalid");
});
