import { describe, expect, test } from "bun:test";

import fixtures from "../conformance/bwg-worker-usb-0.1/fixtures.json";
import { parseWorkerUsbTransportProfileV02 } from "./worker-usb-v02-profile";
import type { WorkerUsbApplicationDescriptor } from "./worker-usb-profile";

describe("Worker USB 0.2 profile", () => {
  test("preserves the exact descriptor while admitting only possession and Controller frames", () => {
    // Arrange
    const topology = structuredClone(fixtures.topology);
    topology.profile = "bwg-worker-usb/0.2";
    topology.reacquisition.physicalIdentity = "device_identity_possession";
    const maybeControl = topology.application.functions[0];
    if (!maybeControl) throw new Error("fixture control function is missing");
    maybeControl.content = "possession_and_controller_frames_only";

    // Act
    const parsed = parseWorkerUsbTransportProfileV02(topology);

    // Assert
    expect(parsed.profile).toBe("bwg-worker-usb/0.2");
    expect(parsed.application.descriptor).toEqual(
      fixtures.topology.application.descriptor as WorkerUsbApplicationDescriptor,
    );
    expect(parsed.application.functions[0].content).toBe(
      "possession_and_controller_frames_only",
    );
    expect(parsed.reacquisition.physicalIdentity).toBe("device_identity_possession");
  });

  test("does not reinterpret the Controller-only USB 0.1 shape as USB 0.2", () => {
    // Arrange
    const topology = structuredClone(fixtures.topology);
    topology.profile = "bwg-worker-usb/0.2";
    topology.reacquisition.physicalIdentity = "device_identity_possession";

    // Act
    const parsing = () => parseWorkerUsbTransportProfileV02(topology);

    // Assert
    expect(parsing).toThrow("Worker USB 0.2 transport profile is invalid");
  });
});
