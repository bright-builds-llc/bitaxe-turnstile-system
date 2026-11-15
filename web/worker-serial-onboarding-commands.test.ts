import { expect, test } from "bun:test";
import type { BrowserSerialController } from "./worker-serial-controller-runtime";
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
