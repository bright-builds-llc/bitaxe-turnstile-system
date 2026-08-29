import { expect, test } from "bun:test";

import controllerFixtures from "../conformance/bwg-worker-controller-0.3/fixtures.json";
import {
  makeDevice,
  testController,
  webUsbHarness,
} from "./webusb-worker-controller-v03-test-harness";
import { workerReacquisitionRestorationMatches } from "./webusb-worker-postconditions";

test("does not use reboot to satisfy an unrelated control failure", () => {
  // Arrange / Act
  const matches = workerReacquisitionRestorationMatches("reboot", "control_failed");

  // Assert
  expect(matches).toBe(false);
});

test("accepts persisted reboot restoration after physical disconnect", async () => {
  // Arrange
  const first = makeDevice("fixture-worker-01");
  const rebooted = makeDevice("fixture-worker-01", {
    maybeStatus: {
      protocolVersion: "bwg-worker-controller/0.3",
      state: "baseline",
      monotonicMilliseconds: 1,
      restoration: { status: "confirmed", reason: "reboot" },
    },
  });
  const harness = webUsbHarness({ devices: [first, rebooted] });
  const controller = testController({
    usb: harness.usb,
    deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
    trustedUpdateKeys: controllerFixtures.updateAuthorityKeys,
    userActivation: () => true,
  });
  const disconnects: string[] = [];
  controller.subscribeDisconnect?.(async (reason) => {
    disconnects.push(reason);
  });
  await controller.requestPermission();
  harness.disconnect(first);

  // Act
  const restoration = await controller.reacquire();

  // Assert
  expect(restoration).toMatchObject({
    state: "baseline",
    restoration: { status: "confirmed", reason: "reboot" },
  });
  expect(disconnects).toEqual(["connectivity_lost"]);
});
