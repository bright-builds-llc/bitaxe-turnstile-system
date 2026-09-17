import { expect, test } from "bun:test";
import { parseWorkerLeaseGrant } from "./worker-controller-semantics";
import { parseWorkerV2Stratum } from "./worker-v2-stratum";
import { v2Stratum } from "./worker-v2-serial.fixture";
import fixtures from "../conformance/bwg-worker-controller-0.4/fixtures.json";
import { canonicalJson } from "./headless-values";
import type { WorkLeaseAuthorityTrust } from "./worker-lease-authorization";
import { signWorkerLeaseAuthorization, verifyWorkerLeaseAuthorization, type WorkerLeaseAuthorizationInput } from "./worker-lease-authorization";

test("legacy grant bytes retain their original untagged fields", () => {
  expect(canonicalJson(parseWorkerLeaseGrant(fixtures.lease))).toBe(canonicalJson(fixtures.lease));
  expect(parseWorkerLeaseGrant({ ...fixtures.lease, stratum: v2Stratum }).stratum).toEqual(v2Stratum);
});
test.each([
  { ...v2Stratum, profile: "unknown" }, { ...v2Stratum, username: "mixed" },
  { ...v2Stratum, authorityPublicKey: undefined }, { ...v2Stratum, suggestedDifficulty: 1024 },
  ...["localhost", "127.0.0.1", "192.168.01.1", "0xc0a80101", "8.8.8.8"].map(host => ({ ...v2Stratum, endpoint: `stratum+tcp://${host}:1234/` })),
  { ...v2Stratum, endpoint: "stratum+tcp://192.168.1.20:01234/" },
  { ...v2Stratum, userIdentity: "\0" }, { ...v2Stratum, userIdentity: "\ud800" }, { ...v2Stratum, userIdentity: "x".repeat(256) },
])("V2 rejects mixed or ambiguous runtime input %#", input => {
  expect(() => parseWorkerV2Stratum(input)).toThrow();
  expect(() => parseWorkerLeaseGrant({ ...fixtures.lease, stratum: input })).toThrow();
});
test("the signer covers the entire V2 profile and required authority", async () => {
  // Arrange
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  if (!jwk.x) throw Error("missing_fixture_key");
  const trust: WorkLeaseAuthorityTrust = { profile: "bwg-worker-deployment-trust/0.2", issuer: "fixture-authority", audience: "bwg-worker-controller/0.4", role: "work_lease_authority", keys: [{ kid: "test-key", kty: "OKP", crv: "Ed25519", x: jwk.x, alg: "Ed25519", use: "sig", key_ops: ["verify"] }] };
  const { authorization: _authorization, ...request } = fixtures.lease;
  const input: WorkerLeaseAuthorizationInput = { operation: "start", activeChallengeId: request.challengeId, controlSessionBindingSha256: "A".repeat(43), request: { ...request, protocolVersion: "bwg-worker-controller/0.4", stratum: v2Stratum, qualificationAttempt: { schema: "worker-qualification-attempt-v1", id: "A".repeat(22), ordinal: 18, purpose: "normal", maximumActiveMilliseconds: 180000 } } };
  // Act
  const signed = await signWorkerLeaseAuthorization({ input, sequence: "1", kid: "test-key", issuer: trust.issuer, audience: trust.audience, privateKey: keys.privateKey });
  // Assert
  expect((await verifyWorkerLeaseAuthorization(signed, input, trust)).sequence).toBe(1n);
  for (const change of [{ endpoint: "stratum+tcp://192.168.1.21:1234/" }, { authorityPublicKey: "B".repeat(42) + "A" }, { userIdentity: "different" }, { profile: "unknown" }]) {
    await expect(verifyWorkerLeaseAuthorization(signed, { ...input, request: { ...input.request, stratum: { ...v2Stratum, ...change } } } as WorkerLeaseAuthorizationInput, trust)).rejects.toThrow();
  }
});
