import { describe, expect, test } from "bun:test";

import controllerFixtures from "../conformance/bwg-worker-controller-0.3/fixtures.json";
import deploymentFixtures from "../conformance/bwg-worker-deployment-trust-0.1/fixtures.json";
import type { WorkerLeaseGrantV03 } from "./worker-controller-v03";
import { createWorkerPossessionChallenge } from "./worker-possession";
import {
  signedPossessionResponse,
  testController,
  webUsbHarness,
} from "./webusb-worker-controller-v03-test-harness";

describe("WebUSB Worker authorization context", () => {
  test("admits the signed Ultra 205 capability with only deployment Update trust", async () => {
    // Arrange
    const harness = webUsbHarness({
      maybeCapability: deploymentFixtures.ultra205.signedCapability,
    });
    const controller = testController({
      usb: harness.usb,
      deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
      trustedUpdateKeys: deploymentFixtures.trust.updateAuthority.keys,
      userActivation: () => true,
    });

    // Act
    await controller.requestPermission();

    // Assert
    await expect(controller.discover()).resolves.toMatchObject({
      board: { model: "bitaxe-ultra", revision: "205" },
    });
  });

  test("the same request produces different contexts for different Device Identities", async () => {
    // Arrange
    const binding = {
      requestId: "pos_context_identity_01",
      purpose: "initial_admission" as const,
      possessionNonce: "N".repeat(43),
      challengeBindingSha256: "C".repeat(43),
      controllerCapabilitySha256: "D".repeat(43),
      applicationDescriptorSha256: "A".repeat(43),
    };
    const first = createWorkerPossessionChallenge(binding);
    const second = createWorkerPossessionChallenge(binding);
    const firstIdentity = crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]);
    const secondIdentity = crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]);

    // Act
    const firstVerified = await first.verify(
      await signedPossessionResponse(first.request, firstIdentity),
    );
    const secondVerified = await second.verify(
      await signedPossessionResponse(second.request, secondIdentity),
    );

    // Assert
    expect(firstVerified.controlSessionBindingSha256).not.toBe(
      secondVerified.controlSessionBindingSha256,
    );
  });

  test("exposes only the Device Identity-bound context digest for Authority issuance", async () => {
    // Arrange
    const harness = webUsbHarness();
    const controller = testController({
      usb: harness.usb,
      deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
      trustedUpdateKeys: controllerFixtures.updateAuthorityKeys,
      userActivation: () => true,
    });
    await controller.requestPermission();

    // Act
    const context = await controller.prepareWorkerLeaseAuthorizationContext("start");

    // Assert
    expect(context).toEqual({
      controlSessionBindingSha256: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(JSON.stringify(context)).not.toMatch(/jwk|fingerprint|proof|serial/i);
  });

  test("requires a fresh possession context after Mining Baseline restoration", async () => {
    // Arrange
    const harness = webUsbHarness();
    const controller = testController({
      usb: harness.usb,
      deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
      trustedUpdateKeys: controllerFixtures.updateAuthorityKeys,
      userActivation: () => true,
    });
    await controller.requestPermission();
    const initial = await controller.prepareWorkerLeaseAuthorizationContext("start");
    await controller.startLease(controllerFixtures.lease as WorkerLeaseGrantV03);
    await controller.pause();

    // Act
    const resumed = await controller.prepareWorkerLeaseAuthorizationContext("start");

    // Assert
    expect(resumed).not.toEqual(initial);
    expect(harness.commands().slice(-2)).toEqual(["pause", "prove_possession"]);
  });
});
