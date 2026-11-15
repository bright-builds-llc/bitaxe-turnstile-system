import { expect, test } from "bun:test";
import type { BrowserSerialController } from "./worker-serial-controller-runtime";
import { createUsbBitaxeOnboarding } from "./bitaxe-usb-onboarding";
import type { UpdateAuthorityJwk } from "./worker-deployment-trust";
import { workerSerialTestRuntime } from "./webserial-worker-port";
import { serialHarness } from "./worker-serial.test-support";

/**
 * The C image answers a rejected request and then ends the session (`revoke_after_send` in
 * `bwg_controller_frame`), so it ignores a later Close and never credits it.
 */
async function rejectingImage(command: "onboarding_inspect" | "onboarding_verify") {
  const harness = await serialHarness();
  harness.setCommandHandler(async (request) => {
    if (request.command !== command) return undefined;
    harness.dropCredits();
    return { ok: false, error: { code: "command_rejected", message: "invalid_request" } };
  });
  const controller = harness.controller as unknown as BrowserSerialController;
  await controller.requestPermission();
  return controller;
}

test("closes promptly after the image rejects onboarding_inspect and ends the session", async () => {
  // Arrange
  const controller = await rejectingImage("onboarding_inspect");
  await expect(controller.onboardingInspect()).rejects.toThrow("command_rejected");

  // Act
  const closing = controller.close();

  // Assert
  await expect(closing).resolves.toBeUndefined();
});

test("closes promptly after the image rejects onboarding_verify and ends the session", async () => {
  // Arrange
  const controller = await rejectingImage("onboarding_verify");
  await expect(controller.onboardingVerify("AAAAAAAAAAAAAAAAAAAAAA")).rejects.toThrow("command_rejected");

  // Act
  const closing = controller.close();

  // Assert
  await expect(closing).resolves.toBeUndefined();
});

test("onboarding connects to an image that answers onboarding_inspect, despite its signed capability envelope", async () => {
  // Arrange
  const harness = await serialHarness();
  harness.setCommandHandler(async (request) => {
    if (request.command !== "onboarding_inspect") return undefined;
    const partition = { scheme: "esp32-factory-ota-ab", appSlotBytes: 4_194_304, rollbackAvailable: true, activeSlot: "ota_0", bootable: true };
    return { ok: true, result: { settingsSchemaVersion: 1, settingsReadable: true, partition } };
  });
  const { onboarding } = createUsbBitaxeOnboarding({
    deviceFilter: harness.input.deviceFilter,
    trustedUpdateKeys: harness.input.trustedUpdateKeys as UpdateAuthorityJwk[],
    maybeRuntime: harness.input[workerSerialTestRuntime].runtime,
  });

  // Act
  const inspection = await onboarding.connect();

  // Assert
  expect(Object.keys(inspection.capabilities).sort()).toEqual(["board", "compatibility", "firmware", "protocolVersion"]);
});
