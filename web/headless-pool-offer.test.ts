import { expect, test } from "bun:test";

import { maybeMaterialReplacementDigest } from "./headless-pool-offer";

test("material replacement digest rejects a malformed alphabet", () => {
  // Arrange
  const malformed = "!".repeat(43);
  // Act
  const wrongAlphabet = () => maybeMaterialReplacementDigest(malformed, true);
  // Assert
  expect(wrongAlphabet).toThrow("material replacement binding is invalid");
});

test("material replacement digest requires trusted confirmation", () => {
  // Arrange
  const digest = "A".repeat(43);
  // Act
  const missingRequirement = () => maybeMaterialReplacementDigest(digest, false);
  // Assert
  expect(missingRequirement).toThrow("material replacement binding is invalid");
});

test("material replacement digest accepts a required SHA-256 binding", () => {
  // Arrange
  const digest = "A".repeat(43);
  // Act
  const result = maybeMaterialReplacementDigest(digest, true);
  // Assert
  expect(result).toBe(digest);
});
