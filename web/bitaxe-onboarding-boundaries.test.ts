import { describe, expect, test } from "bun:test";

import vectors from "../conformance/bwg-bitaxe-onboarding-0.2/settings-hmac-vectors.json";
import { parseDeviceSnapshot, parseVerification } from "./bitaxe-onboarding-boundaries";
import { admitFirmwarePackage, type UpdateAuthorityJwk } from "./bitaxe-firmware-package";
import { firmwarePackage, signedPackage, snapshot } from "./bitaxe-onboarding-test-fixtures";

const replies = vectors.verificationReplies;

describe("device snapshot partition", () => {
  test.each(["factory", "ota_0", "ota_1"] as const)(
    "accepts esp32-factory-ota-ab running from %s",
    (activeSlot) => {
      // Arrange
      const input = snapshot({ partition: { ...snapshot().partition, activeSlot } });

      // Act
      const parsed = parseDeviceSnapshot(input);

      // Assert
      expect(parsed.partition.activeSlot).toBe(activeSlot);
    },
  );

  test.each(["esp32-ota-ab", "esp32-factory-ota-abc", "single-factory"])(
    "refuses the %s scheme",
    (scheme) => {
      // Arrange
      const input = { ...snapshot(), partition: { ...snapshot().partition, scheme } };

      // Act
      const parse = () => parseDeviceSnapshot(input);

      // Assert
      expect(parse).toThrow("Bitaxe onboarding snapshot is invalid");
    },
  );

  test("refuses a slot the table does not have", () => {
    // Arrange
    const input = { ...snapshot(), partition: { ...snapshot().partition, activeSlot: "ota_2" } };

    // Act
    const parse = () => parseDeviceSnapshot(input);

    // Assert
    expect(parse).toThrow("Bitaxe onboarding snapshot is invalid");
  });
});

describe("post-reboot verification", () => {
  test("accepts the shared reply under the browser's nonce", () => {
    // Arrange
    const [accepted] = replies.accepted;

    // Act
    const parsed = parseVerification(accepted?.reply, replies.expectedNonce);

    // Assert
    expect<unknown>(parsed.categories).toEqual(accepted?.reply.categories);
  });

  test.each(
    replies.refused
      .filter((vector) => vector.name !== "reply-under-another-nonce")
      .map((vector) => [vector.name, vector.reply] as const),
  )("refuses %s", (_name, reply) => {
    // Arrange
    const input: unknown = reply;

    // Act
    const parse = () => parseVerification(input, replies.expectedNonce);

    // Assert
    expect(parse).toThrow("redacted settings verification is invalid");
  });

  test("refuses a well-formed reply under another nonce", () => {
    // Arrange
    const other = replies.refused.find((vector) => vector.name === "reply-under-another-nonce");

    // Act
    const parse = () => parseVerification(other?.reply, replies.expectedNonce);

    // Assert
    expect(parse).toThrow("redacted settings verification is under another nonce");
  });

  test("accepts a reply from the factory slot after a rollback", () => {
    // Arrange
    const [accepted] = replies.accepted;
    const reply = { ...accepted?.reply, activeSlot: "factory" };

    // Act
    const parsed = parseVerification(reply, replies.expectedNonce);

    // Assert
    expect(parsed.activeSlot).toBe("factory");
  });
});

describe("signed manifest partition block", () => {
  test("admits esp32-factory-ota-ab for a device running from factory", async () => {
    // Arrange
    const signed = await firmwarePackage();

    // Act
    const admitted = await admitFirmwarePackage(signed.package, [signed.publicKey], snapshot());

    // Assert
    expect(admitted.manifest.partition.scheme).toBe("esp32-factory-ota-ab");
  });

  test.each([
    ["the esp32-ota-ab scheme", { partition: { scheme: "esp32-ota-ab", minimumAppSlotBytes: 1, rollbackRequired: true } }],
    ["the 0.1 profile", { profile: "bwg-reference-firmware/0.1" }],
  ] as const)("refuses a correctly signed manifest with %s", async (_name, change) => {
    // Arrange
    const signed = await firmwarePackage();
    const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const publicKey = {
      ...signed.publicKey,
      ...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
      kid: signed.publicKey.kid,
    } as UpdateAuthorityJwk;
    const resigned = await signedPackage({ ...signed.package.manifest, ...change }, keys.privateKey);

    // Act
    const admit = admitFirmwarePackage(resigned, [publicKey], snapshot());

    // Assert
    await expect(admit).rejects.toThrow("firmware manifest is invalid");
  });
});
