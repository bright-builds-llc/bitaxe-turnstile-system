import { expect, test } from "bun:test";

import { validateLookupClaims, verifyLookupProof } from "./crypto-webcrypto.mjs";

test("WebCrypto verifies the portable lookup proof vectors", async () => {
  // Arrange
  const vectors = await Bun.file(
    new URL("./lookup-proof-vectors.json", import.meta.url),
  ).json();

  // Act
  const issuance = await verifyLookupProof(
    vectors.issuance_proof.compact_jws,
    vectors.issuance_proof.type,
    "challenge_id",
  );
  const outcome = await verifyLookupProof(
    vectors.outcome_proof.compact_jws,
    vectors.outcome_proof.type,
    "action_reference",
  );

  // Assert
  expect(vectors.profile).toBe("BWG/0.1");
  expect(vectors.algorithm).toBe("ES256");
  expect(issuance.claims).toEqual(vectors.issuance_proof.claims);
  expect(outcome.claims).toEqual(vectors.outcome_proof.claims);
  expect(issuance.jkt).toBe(outcome.jkt);
});

test("WebCrypto rejects a wrong lookup proof type", async () => {
  const vectors = await lookupVectors();
  await expect(
    verifyLookupProof(
      vectors.issuance_proof.compact_jws,
      vectors.outcome_proof.type,
      "challenge_id",
    ),
  ).rejects.toThrow("invalid_lookup_proof_type");
});

test("lookup proof claims require GET and their resource", () => {
  const invalid = { jti: "proof", htm: "GET", htu: "https://example.test", iat: 1 };
  expect(() => validateLookupClaims(invalid, "challenge_id")).toThrow(
    "invalid_lookup_proof_claims",
  );
});

test("lookup proof claims reject a non-GET method", () => {
  const invalid = {
    jti: "proof",
    htm: "POST",
    htu: "https://example.test",
    iat: 1,
    challenge_id: "challenge_01",
  };
  expect(() => validateLookupClaims(invalid, "challenge_id")).toThrow(
    "invalid_lookup_proof_claims",
  );
});

test("lookup proof claims reject a non-integer timestamp", () => {
  const invalid = {
    jti: "proof",
    htm: "GET",
    htu: "https://example.test",
    iat: 1.5,
    challenge_id: "challenge_01",
  };
  expect(() => validateLookupClaims(invalid, "challenge_id")).toThrow(
    "invalid_lookup_proof_claims",
  );
});

test("lookup proof claims reject a non-positive timestamp", () => {
  const invalid = {
    jti: "proof",
    htm: "GET",
    htu: "https://example.test",
    iat: 0,
    challenge_id: "challenge_01",
  };
  expect(() => validateLookupClaims(invalid, "challenge_id")).toThrow(
    "invalid_lookup_proof_claims",
  );
});

test("WebCrypto rejects an invalid lookup proof signature", async () => {
  const vectors = await lookupVectors();
  const segments = vectors.outcome_proof.compact_jws.split(".");
  segments[2] = `${segments[2].startsWith("A") ? "B" : "A"}${segments[2].slice(1)}`;
  const invalid = segments.join(".");
  await expect(
    verifyLookupProof(invalid, vectors.outcome_proof.type, "action_reference"),
  ).rejects.toThrow("invalid_signature");
});

async function lookupVectors() {
  return Bun.file(new URL("./lookup-proof-vectors.json", import.meta.url)).json();
}
