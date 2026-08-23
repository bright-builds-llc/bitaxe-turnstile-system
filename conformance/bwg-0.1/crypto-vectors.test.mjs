import { expect, test } from "bun:test";

import {
  runCryptoConformance,
  verifyDpop,
  verifyGatePass,
} from "./crypto-webcrypto.mjs";

test("WebCrypto verifies the BWG/0.1 cryptographic vectors", async () => {
  // Arrange
  const vectors = await Bun.file(
    new URL("./crypto-vectors.json", import.meta.url),
  ).json();

  // Act
  const result = await runCryptoConformance(vectors);

  // Assert
  expect(result).toEqual({
    gatePassesVerified: 2,
    rotationCasesVerified: 5,
    algorithmFailuresVerified: 5,
    criticalHeaderFailuresVerified: 2,
    dpopFailuresVerified: 2,
    dpopVerified: true,
    claimantPrivateKeyExtractable: false,
    claimantPublicKeyExtractable: true,
  });
});

test("WebCrypto rejects malformed compact JWS", async () => {
  // Arrange
  const malformed = "header.payload";

  // Act and Assert
  await expect(verifyGatePass(malformed, [])).rejects.toThrow("malformed_jws");
});

test("WebCrypto rejects invalid base64url", async () => {
  // Arrange
  const invalid = "***.e30.c2ln";

  // Act and Assert
  await expect(verifyGatePass(invalid, [])).rejects.toThrow("invalid_base64url");
});

test("WebCrypto rejects invalid protected-header JSON", async () => {
  // Arrange
  const invalid = "bm90LWpzb24.e30.c2ln";

  // Act and Assert
  await expect(verifyGatePass(invalid, [])).rejects.toThrow("invalid_json");
});

test("WebCrypto rejects an invalid Gate Pass type", async () => {
  // Arrange
  const vectors = await cryptoVectors();
  const gatePass = requiredById(vectors.gate_passes, "signed-by-authority-b");
  const wrongType = replaceProtectedHeader(gatePass.compact_jws, {
    typ: "JWT",
    alg: "Ed25519",
    kid: "authority-b",
  });

  // Act and Assert
  await expect(verifyGatePass(wrongType, [])).rejects.toThrow("invalid_gate_pass_type");
});

test("WebCrypto rejects an invalid DPoP type", async () => {
  // Arrange
  const vectors = await cryptoVectors();
  const header = protectedHeader(vectors.dpop.compact_jws);
  const wrongType = replaceProtectedHeader(vectors.dpop.compact_jws, {
    ...header,
    typ: "JWT",
  });

  // Act and Assert
  await expect(verifyDpop(wrongType, vectors.dpop.access_token)).rejects.toThrow(
    "invalid_dpop_type",
  );
});

test("WebCrypto rejects invalid Authority JWK metadata", async () => {
  // Arrange
  const vectors = await cryptoVectors();
  const authorityB = requiredById(vectors.authority_keys, "authority-b");
  const gatePass = requiredById(vectors.gate_passes, "signed-by-authority-b");
  const invalidKey = { ...authorityB, kty: "EC" };

  // Act and Assert
  await expect(verifyGatePass(gatePass.compact_jws, [invalidKey])).rejects.toThrow(
    "invalid_authority_key",
  );
});

test("WebCrypto rejects an invalid Gate Pass signature", async () => {
  // Arrange
  const vectors = await cryptoVectors();
  const authorityB = requiredById(vectors.authority_keys, "authority-b");
  const gatePass = requiredById(vectors.gate_passes, "signed-by-authority-b");
  const tampered = tamperSignature(gatePass.compact_jws);

  // Act and Assert
  await expect(verifyGatePass(tampered, [authorityB])).rejects.toThrow("invalid_signature");
});

test("WebCrypto rejects duplicate Authority key identifiers", async () => {
  // Arrange
  const vectors = await cryptoVectors();
  const authorityB = requiredById(vectors.authority_keys, "authority-b");
  const gatePass = requiredById(vectors.gate_passes, "signed-by-authority-b");

  // Act and Assert
  await expect(verifyGatePass(gatePass.compact_jws, [authorityB, authorityB])).rejects.toThrow(
    "ambiguous_kid",
  );
});

test("WebCrypto rejects a DPoP access-token hash mismatch", async () => {
  // Arrange
  const vectors = await cryptoVectors();

  // Act and Assert
  await expect(verifyDpop(vectors.dpop.compact_jws, "different-access-token")).rejects.toThrow(
    "access_token_hash_mismatch",
  );
});

test("WebCrypto rejects a DPoP JWK algorithm mismatch", async () => {
  // Arrange
  const vectors = await cryptoVectors();
  const mismatch = requiredById(vectors.dpop_negative_cases, "dpop-mismatched-jwk-algorithm");

  // Act and Assert
  await expect(verifyDpop(mismatch.compact_jws, mismatch.access_token)).rejects.toThrow(
    "algorithm_key_mismatch",
  );
});

test("WebCrypto rejects unknown critical JOSE headers", async () => {
  // Arrange
  const vectors = await cryptoVectors();
  const critical = requiredById(
    vectors.critical_header_negative_cases,
    "dpop-unknown-critical-header",
  );

  // Act and Assert
  await expect(verifyDpop(critical.compact_jws, critical.access_token)).rejects.toThrow(
    "unsupported_critical_header",
  );
});

test("WebCrypto rejects invalid required DPoP claims", async () => {
  // Arrange
  const vectors = await cryptoVectors();
  const invalidClaims = requiredById(vectors.dpop_negative_cases, "dpop-invalid-required-claims");

  // Act and Assert
  await expect(verifyDpop(invalidClaims.compact_jws, invalidClaims.access_token)).rejects.toThrow(
    "invalid_dpop_claims",
  );
});

function cryptoVectors() {
  return Bun.file(new URL("./crypto-vectors.json", import.meta.url)).json();
}

function requiredById(values, id) {
  const maybeValue = values.find((value) => value.id === id || value.kid === id);
  if (!maybeValue) throw new Error(`missing vector ${id}`);
  return maybeValue;
}

function replaceProtectedHeader(compactJws, header) {
  const segments = compactJws.split(".");
  if (segments.length !== 3) throw new Error("fixture JWS is malformed");
  const protectedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  return `${protectedHeader}.${segments[1]}.${segments[2]}`;
}

function protectedHeader(compactJws) {
  const [protectedValue] = compactJws.split(".");
  return JSON.parse(Buffer.from(protectedValue, "base64url"));
}

function tamperSignature(compactJws) {
  const segments = compactJws.split(".");
  if (segments.length !== 3) throw new Error("fixture JWS is malformed");
  const signature = Buffer.from(segments[2], "base64url");
  signature[0] ^= 1;
  return `${segments[0]}.${segments[1]}.${signature.toString("base64url")}`;
}
