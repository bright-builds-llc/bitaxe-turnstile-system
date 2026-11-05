#!/usr/bin/env bun
/**
 * Builds the vectors the Rust Authority signer must reproduce byte for byte.
 * The key is the public RFC 8032 test vector 2 seed, never a deployment key.
 */
import { writeFile } from "node:fs/promises";

import { encodeBase64Url } from "../web/crypto-bytes";
import {
  signWorkerLeaseAuthorization,
  WORKER_DEPLOYMENT_TRUST_PROFILE,
  type WorkerLeaseAuthorizationInput,
} from "../web/worker-lease-authorization";

export const WORK_LEASE_AUTHORITY_VECTORS_PATH =
  "conformance/bwg-worker-deployment-trust-0.2/authority-signer-vectors.json";

const RFC8032_TEST_2_SEED_HEX =
  "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb";
const KID = "test-work-lease-authority";
const ISSUER = "test-work-lease-authority";
const AUDIENCE = "bwg-worker-controller/0.4";
const CHALLENGE_ID = "challenge_00000000000000000000000000000001";
const CONTROL_SESSION = "jEc1ro90lL2fX0ZozUbY0XpmxrC46gEkEUKKTyGj0Zs";

const CASES: readonly {
  name: string;
  sequence: string;
  input: WorkerLeaseAuthorizationInput;
}[] = [
  {
    name: "start",
    sequence: "1",
    input: {
      operation: "start",
      activeChallengeId: CHALLENGE_ID,
      controlSessionBindingSha256: CONTROL_SESSION,
      request: {
        protocolVersion: "bwg-worker-controller/0.4",
        leaseId: "0b8f5c1e-3a7d-4e2b-9c61-2f4d8a9e7b10",
        challengeId: CHALLENGE_ID,
        durationMilliseconds: 60000,
        renewAfterMilliseconds: 20000,
        stratum: {
          endpoint: "stratum+tcp://pool-adapter.test:3333/",
          username: "bwg_test-session-user",
          password: "test-session-password",
        },
      },
    },
  },
  {
    name: "renew_at_allocator_ceiling",
    sequence: "9223372036854775807",
    input: {
      operation: "renew",
      activeChallengeId: CHALLENGE_ID,
      controlSessionBindingSha256: CONTROL_SESSION,
      request: {
        protocolVersion: "bwg-worker-controller/0.4",
        leaseId: "0b8f5c1e-3a7d-4e2b-9c61-2f4d8a9e7b10",
        durationMilliseconds: 60000,
        renewAfterMilliseconds: 20000,
      },
    },
  },
];

/** Signs every case with the public test seed. */
export async function buildWorkLeaseAuthorityVectors(): Promise<unknown> {
  const seed = Uint8Array.from(Buffer.from(RFC8032_TEST_2_SEED_HEX, "hex"));
  const pkcs8 = Uint8Array.from([
    ...Buffer.from("302e020100300506032b657004220420", "hex"),
    ...seed,
  ]);
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    "Ed25519",
    true,
    ["sign"],
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", privateKey);
  const cases = [];
  for (const vector of CASES) {
    cases.push({
      ...vector,
      authorization: await signWorkerLeaseAuthorization({
        input: vector.input,
        sequence: vector.sequence,
        kid: KID,
        issuer: ISSUER,
        audience: AUDIENCE,
        privateKey,
      }),
    });
  }
  return {
    note: "Test-only key: RFC 8032 section 7.1 test 2. Never a deployment key.",
    seedBase64Url: encodeBase64Url(seed),
    trust: {
      profile: WORKER_DEPLOYMENT_TRUST_PROFILE,
      issuer: ISSUER,
      audience: AUDIENCE,
      role: "work_lease_authority",
      keys: [
        {
          kid: KID,
          kty: "OKP",
          crv: "Ed25519",
          x: privateJwk.x,
          alg: "Ed25519",
          use: "sig",
          key_ops: ["verify"],
        },
      ],
    },
    cases,
  };
}

if (import.meta.main) {
  const vectors = await buildWorkLeaseAuthorityVectors();
  await writeFile(
    WORK_LEASE_AUTHORITY_VECTORS_PATH,
    JSON.stringify(vectors, null, 2) + "\n",
  );
  console.log(`wrote ${WORK_LEASE_AUTHORITY_VECTORS_PATH}`);
}
