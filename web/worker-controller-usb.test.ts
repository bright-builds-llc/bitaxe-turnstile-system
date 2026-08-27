import { expect, test } from "bun:test";

import fixtures from "../conformance/bwg-worker-controller-0.1/fixtures.json";
import {
  SimulatedWorkerController,
  SimulatedWorkerControllerClock,
} from "./simulated-worker-controller";
import { simulatedWorkerControllerUsbExchange } from "./simulated-worker-controller-usb";
import type {
  WorkerControllerCapabilities,
  WorkerLeaseGrant,
} from "./worker-controller";
import {
  MAXIMUM_WORKER_CONTROLLER_USB_FRAME_BYTES,
  UsbWorkerController,
  decodeWorkerControllerUsbResponse,
  decodeWorkerControllerUsbRequest,
  encodeWorkerControllerUsbMessage,
} from "./worker-controller-usb";
import { fixtureAuthorizationVerifier } from "./worker-controller.test-support";

test("USB adapter drives the public controller through bounded JSON-lines frames", async () => {
  // Arrange
  const simulator = new SimulatedWorkerController(
    fixtures.capabilities as WorkerControllerCapabilities,
    new SimulatedWorkerControllerClock("boot_usb_01", 0, 1),
    fixtureAuthorizationVerifier,
  );
  const controller = new UsbWorkerController(simulatedWorkerControllerUsbExchange(simulator));

  // Act
  const discovered = await controller.discover();
  const started = await controller.startLease(fixtures.lease as WorkerLeaseGrant);
  const restored = await controller.pause();

  // Assert
  expect(discovered).toEqual(fixtures.capabilities as WorkerControllerCapabilities);
  expect(started.state).toBe("mining");
  expect(restored.restoration).toEqual({ status: "confirmed", reason: "paused" });
});

test("USB disconnect restores locally and notifies the host", async () => {
  // Arrange
  const simulator = new SimulatedWorkerController(
    fixtures.capabilities as WorkerControllerCapabilities,
    new SimulatedWorkerControllerClock("boot_usb_disconnect", 0, 1),
    fixtureAuthorizationVerifier,
  );
  const exchange = simulatedWorkerControllerUsbExchange(simulator);
  const controller = new UsbWorkerController(exchange);
  const reasons: string[] = [];
  controller.subscribeDisconnect(async (reason) => {
    reasons.push(reason);
  });
  await controller.startLease(fixtures.lease as WorkerLeaseGrant);

  // Act
  await exchange.disconnect();

  // Assert
  expect(reasons).toEqual(["connectivity_lost"]);
  expect((await simulator.status()).restoration).toEqual({
    status: "confirmed",
    reason: "connectivity_lost",
  });
});

test("USB codec rejects multiple frames", () => {
  // Arrange
  const multiple = new TextEncoder().encode(
    '{"protocolVersion":"bwg-worker-controller/0.1","requestId":"usb_1","command":"status"}\n{}\n',
  );

  // Act
  const decodeMultiple = () => decodeWorkerControllerUsbRequest(multiple);

  // Assert
  expect(decodeMultiple).toThrow("Worker Controller USB frame is invalid");
});

test("USB codec rejects an oversized frame", () => {
  // Arrange
  const oversized = new Uint8Array(MAXIMUM_WORKER_CONTROLLER_USB_FRAME_BYTES + 1);

  // Act
  const decodeOversized = () => decodeWorkerControllerUsbRequest(oversized);

  // Assert
  expect(decodeOversized).toThrow("Worker Controller USB frame is invalid");
});

test("USB rejection never echoes credential-bearing payloads", async () => {
  // Arrange
  const simulator = new SimulatedWorkerController(
    fixtures.capabilities as WorkerControllerCapabilities,
    new SimulatedWorkerControllerClock("boot_usb_02", 0, 1),
    fixtureAuthorizationVerifier,
  );
  const exchange = simulatedWorkerControllerUsbExchange(simulator);
  const request = {
    protocolVersion: "bwg-worker-controller/0.1",
    requestId: "usb_rejected",
    command: "start_lease",
    payload: { ...(fixtures.lease as WorkerLeaseGrant), durationMilliseconds: 60_001 },
  };

  // Act
  const response = new TextDecoder().decode(
    await exchange.transact(encodeWorkerControllerUsbMessage(request)),
  );

  // Assert
  expect(response).not.toContain(fixtures.lease.authorization);
  expect(response).not.toContain(fixtures.lease.stratum.username);
  expect(response).not.toContain(fixtures.lease.stratum.password);
});

test("USB adapter replaces a device-supplied secret-bearing error", async () => {
  // Arrange
  const controller = new UsbWorkerController({
    async transact(request) {
      const requestId = decodeWorkerControllerUsbRequest(request).requestId;
      return encodeWorkerControllerUsbMessage({
        protocolVersion: "bwg-worker-controller/0.1",
        requestId,
        ok: false,
        error: {
          code: "command_rejected",
          message: `rejected ${fixtures.lease.authorization}`,
        },
      });
    },
    subscribeDisconnect() {
      return () => undefined;
    },
  });

  // Act
  let maybeError: unknown;
  try {
    await controller.status();
  } catch (error) {
    maybeError = error;
  }

  // Assert
  expect(String(maybeError)).toBe("Error: Worker Controller command was rejected");
  expect(String(maybeError)).not.toContain(fixtures.lease.authorization);
});

test("USB envelope rejects an overlong request identity", () => {
  // Arrange
  const frame = encodeWorkerControllerUsbMessage({
    protocolVersion: "bwg-worker-controller/0.1",
    requestId: `usb_${"a".repeat(129)}`,
    ok: true,
    result: {},
  });

  // Act
  const decode = () => decodeWorkerControllerUsbResponse(frame);

  // Assert
  expect(decode).toThrow("Worker Controller USB envelope is invalid");
});
