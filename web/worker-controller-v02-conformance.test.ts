import { expect, test } from "bun:test";

import fixtures from "../conformance/bwg-worker-controller-0.2/fixtures.json";
import {
  assertWorkerControllerUsbCorrelationV02,
  decodeWorkerControllerUsbRequestV02,
  decodeWorkerControllerUsbResponseV02,
  encodeWorkerControllerUsbMessageV02,
} from "./worker-controller-usb-v02";
import { MAXIMUM_WORKER_CONTROLLER_USB_FRAME_BYTES } from "./worker-controller-usb";

for (const vector of fixtures.negativeTransfers) {
  test(`shared Controller 0.2 transfer vector: ${vector.id}`, () => {
    // Arrange
    const frame = negativeFrame(vector.operation);

    // Act / Assert
    expect(() => decodeWorkerControllerUsbRequestV02(frame)).toThrow(
      vector.expectedError === "invalid_message"
        ? "Worker Controller 0.2 USB message is invalid"
        : "Worker Controller 0.2 USB frame is invalid",
    );
  });
}

for (const vector of fixtures.usbVectors) {
  test(`shared Controller 0.2 USB vector: ${vector.id}`, () => {
    // Arrange
    if (!("request" in vector) || !("response" in vector)) {
      const frame = new TextEncoder().encode(vector.requestText);

      // Act / Assert
      expect(() => decodeWorkerControllerUsbRequestV02(frame)).toThrow(
        "Worker Controller 0.2 USB frame is invalid",
      );
      return;
    }

    // Act
    const request = decodeWorkerControllerUsbRequestV02(
      encodeWorkerControllerUsbMessageV02(vector.request),
    );
    const response = decodeWorkerControllerUsbResponseV02(
      encodeWorkerControllerUsbMessageV02(vector.response),
    );

    if ("expectedError" in vector && vector.expectedError === "correlation") {
      expect(() => assertWorkerControllerUsbCorrelationV02(request, response)).toThrow(
        "Worker Controller 0.2 USB response identity mismatch",
      );
      return;
    }
    assertWorkerControllerUsbCorrelationV02(request, response);

    // Assert
    expect(request as unknown).toEqual(vector.request);
    expect(response as unknown).toEqual(vector.response);
  });
}

function negativeFrame(operation: string): Uint8Array {
  const valid = encodeWorkerControllerUsbMessageV02({
    protocolVersion: "bwg-worker-controller/0.2",
    requestId: "usb_v02_negative",
    command: "status",
  });
  if (operation === "empty") return new Uint8Array();
  if (operation === "oversized") {
    return new Uint8Array(MAXIMUM_WORKER_CONTROLLER_USB_FRAME_BYTES + 1);
  }
  if (operation === "invalid_utf8") return new Uint8Array([255, 10]);
  if (operation === "invalid_json") return new TextEncoder().encode("{invalid}\n");
  if (operation === "missing_lf") return valid.slice(0, -1);
  if (operation === "multiple_frames") {
    const frames = new Uint8Array(valid.byteLength * 2);
    frames.set(valid);
    frames.set(valid, valid.byteLength);
    return frames;
  }
  if (operation === "unknown_request_field") {
    return encodeWorkerControllerUsbMessageV02({
      protocolVersion: "bwg-worker-controller/0.2",
      requestId: "usb_v02_negative",
      command: "status",
      password: "must-not-enter-envelope",
    });
  }
  throw new Error(`unknown negative transfer operation: ${operation}`);
}
