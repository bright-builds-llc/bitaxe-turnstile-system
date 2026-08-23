import { expect, test } from "bun:test";

import { runCryptoConformance } from "./crypto-webcrypto.mjs";

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
    dpopVerified: true,
    claimantPrivateKeyExtractable: false,
    claimantPublicKeyExtractable: true,
  });
});
