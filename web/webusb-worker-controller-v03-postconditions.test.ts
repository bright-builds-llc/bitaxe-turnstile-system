import { describe, expect, test } from "bun:test";

import controllerFixtures from "../conformance/bwg-worker-controller-0.3/fixtures.json";
import type {
  WorkerLeaseGrantV03,
  WorkerLeaseRenewalV03,
} from "./worker-controller-v03";
import {
  makeDevice,
  testController,
  webUsbHarness,
} from "./webusb-worker-controller-v03-test-harness";

describe("WebUSB Worker Controller 0.3 command postconditions", () => {
  test("rejects a successful Start response that did not activate the exact lease", async () => {
    // Arrange
    const events: string[] = [];
    const device = makeDevice("fixture-worker-01", {
      events,
      maybeResultByCommand: {
        start_lease: controllerFixtures.status,
      },
    });
    const harness = webUsbHarness({ devices: [device] });
    const controller = testController({
      usb: harness.usb,
      deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
      trustedUpdateKeys: controllerFixtures.updateAuthorityKeys,
      userActivation: () => true,
    });
    await controller.requestPermission();

    // Act
    const start = controller.startLease(controllerFixtures.lease as WorkerLeaseGrantV03);

    // Assert
    await expect(start).rejects.toThrow("Work Lease postcondition is invalid");
    await expect(controller.status()).rejects.toThrow("reacquisition is required");
    expect(events.slice(-2)).toEqual(["release:0", "close"]);
  });

  test("rejects a successful Pause response that remains mining", async () => {
    // Arrange
    const mining = controllerFixtures.usbVectors?.find(
      (vector) => vector.request?.command === "start_lease",
    )?.response?.result;
    if (!mining) throw new Error("fixture mining response is missing");
    const events: string[] = [];
    const device = makeDevice("fixture-worker-01", {
      events,
      maybeResultByCommand: { pause: mining },
    });
    const harness = webUsbHarness({ devices: [device] });
    const controller = testController({
      usb: harness.usb,
      deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
      trustedUpdateKeys: controllerFixtures.updateAuthorityKeys,
      userActivation: () => true,
    });
    await controller.requestPermission();

    // Act
    const pause = controller.pause();

    // Assert
    await expect(pause).rejects.toThrow("restoration is unconfirmed");
    await expect(controller.status()).rejects.toThrow("reacquisition is required");
    expect(events.slice(-2)).toEqual(["release:0", "close"]);
  });

  test("rejects a successful renewal response for a different lease", async () => {
    // Arrange
    const renewed = structuredClone(
      controllerFixtures.usbVectors?.find(
        (vector) => vector.request?.command === "renew_lease",
      )?.response?.result,
    );
    if (!renewed || !("lease" in renewed)) {
      throw new Error("fixture renewal response is missing");
    }
    renewed.lease.leaseId = "lease_different_03";
    const events: string[] = [];
    const device = makeDevice("fixture-worker-01", {
      events,
      maybeResultByCommand: { renew_lease: renewed },
    });
    const harness = webUsbHarness({ devices: [device] });
    const controller = testController({
      usb: harness.usb,
      deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
      trustedUpdateKeys: controllerFixtures.updateAuthorityKeys,
      userActivation: () => true,
    });
    await controller.requestPermission();
    await controller.startLease(controllerFixtures.lease as WorkerLeaseGrantV03);

    // Act
    const renewal = controller.renewLease(
      controllerFixtures.renewal as WorkerLeaseRenewalV03,
    );

    // Assert
    await expect(renewal).rejects.toThrow("Work Lease postcondition is invalid");
    await expect(controller.status()).rejects.toThrow("reacquisition is required");
    expect(events.slice(-2)).toEqual(["release:0", "close"]);
  });

  test("retains a retry handle when fail-closed cleanup cannot close the device", async () => {
    // Arrange
    const events: string[] = [];
    const device = makeDevice("fixture-worker-01", {
      closeFailsOnce: true,
      events,
      maybeResultByCommand: { start_lease: controllerFixtures.status },
    });
    const harness = webUsbHarness({ devices: [device] });
    const controller = testController({
      usb: harness.usb,
      deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
      trustedUpdateKeys: controllerFixtures.updateAuthorityKeys,
      userActivation: () => true,
    });
    await controller.requestPermission();

    // Act
    const start = controller.startLease(controllerFixtures.lease as WorkerLeaseGrantV03);

    // Assert
    await expect(start).rejects.toBeInstanceOf(AggregateError);
    expect(device.opened).toBeTrue();
    await expect(controller.close()).rejects.toThrow("Work Lease postcondition is invalid");
    expect(device.opened).toBeFalse();
    expect(events.slice(-4)).toEqual(["release:0", "close", "release:0", "close"]);
    await expect(controller.status()).rejects.toThrow("reacquisition is required");
  });
});
