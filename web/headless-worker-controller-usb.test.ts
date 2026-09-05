import { expect, test } from "bun:test";

import fixtures from "../conformance/bwg-worker-controller-0.4/fixtures.json";
import { createHeadlessClient } from "./headless-client";
import { headlessInput, transportHarness } from "./headless-client.test-support";
import {
  SimulatedWorkerController,
  SimulatedWorkerControllerClock,
} from "./simulated-worker-controller";
import { simulatedWorkerControllerSerialExchange } from "./simulated-worker-controller-serial";
import type { WorkerControllerCapabilities, WorkerLeaseGrant } from "./worker-controller";
import { fixtureAuthorizationVerifier } from "./worker-controller.test-support";
import { SerialWorkerController } from "./worker-controller-serial";

test("real USB controller path restores after admission rollback", async () => {
  // Arrange
  const simulator = new SimulatedWorkerController(
    fixtures.capabilities as WorkerControllerCapabilities,
    new SimulatedWorkerControllerClock("boot_headless_serial_01", 0, 1),
    fixtureAuthorizationVerifier,
  );
  const controller = new SerialWorkerController(simulatedWorkerControllerSerialExchange(simulator));
  const authority = transportHarness();
  const transport = {
    ...authority.transport,
    async start() {
      authority.calls.push("start");
      return {
        ...(fixtures.lease as WorkerLeaseGrant),
        challengeId: "challenge_00000000000000000000000000000002",
      };
    },
  };
  const client = await createHeadlessClient({
    ...(await headlessInput(transport)),
    maybeWorkerController: controller,
  });
  await client.grantConsent();

  // Act
  const start = client.start();

  // Assert
  await expect(start).rejects.toThrow("does not match the active Work Challenge");
  expect(authority.calls).toEqual(["start", "pause"]);
  expect((await simulator.status()).restoration).toEqual({
    status: "confirmed",
    reason: "control_failed",
  });
});
